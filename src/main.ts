import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  changeMarker,
  loadBoard,
  loadIssue,
  openWorkspace,
  type BoardData,
  type Issue,
  type StatusCategory,
  type Workspace,
} from "./beads";
import {
  buildColumns,
  childProgress,
  DEFAULT_FILTERS,
  filterOptions,
  UNASSIGNED,
  visibleColumns,
  type Filters,
  type Progress,
} from "./board";
import { renderDetail, type DetailContext, type DetailState } from "./detail";
import { el, icon } from "./dom";
import { buildGraph, type GraphDirection } from "./graph";
import { renderGraph } from "./graph-view";
import { issueRefPattern, type IssueRefs } from "./markdown";
import { renderColumns } from "./render";
import { scrollSideways } from "./wheel";

/** How often to look for a write by bd; the check only reads a file's modification time. */
const WATCH_INTERVAL_MS = 2_000;
/** Reload at least this often, for changes that leave no marker, such as a Dolt pull. */
const FULL_REFRESH_MS = 60_000;
/** Reload when the window regains focus if the board is older than this. */
const FOCUS_REFRESH_MS = 5_000;
const MAX_RECENTS = 8;
const RECENTS_KEY = "recent-workspaces";
const DONE_DAYS_KEY = "done-days";
/** The choices in the "Done" filter; 0 shows every closed issue. */
const DONE_DAY_CHOICES = [1, 7, 30, 0];
const ZOOM_KEY = "zoom";
/** The steps ⌘+ and ⌘− move through, as in a browser. */
const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const APP_TITLE = "ASDLC Dashboard";

interface State {
  root: string | null;
  workspace: Workspace | null;
  data: BoardData | null;
  /** The JSON of `data`, to skip work when a reload returns the same issues. */
  signature: string;
  issuesById: Map<string, Issue>;
  progress: Map<string, Progress>;
  refs: IssueRefs | null;
  filters: Filters;
  selectedId: string | null;
  detail: DetailState | null;
  /** The issue the dependency graph is drawn from, while the graph is open. */
  graphRootId: string | null;
  graphDirection: GraphDirection;
  marker: number | null;
  checkedAt: number;
  /** Bumped when a workspace opens, so answers about the previous one are dropped. */
  generation: number;
  /** Page zoom, one of ZOOM_LEVELS. Every window shares it. */
  zoom: number;
}

const state: State = {
  root: null,
  workspace: null,
  data: null,
  signature: "",
  issuesById: new Map(),
  progress: new Map(),
  refs: null,
  filters: { ...DEFAULT_FILTERS, doneDays: storedDoneDays() },
  selectedId: null,
  detail: null,
  graphRootId: null,
  graphDirection: "dependencies",
  marker: null,
  checkedAt: 0,
  generation: 0,
  zoom: storedZoom(),
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const boardEl = $<HTMLElement>("board");
const emptyEl = $<HTMLElement>("empty");
const detailEl = $<HTMLElement>("detail");
const graphEl = $<HTMLElement>("graph");
const bannerEl = $<HTMLElement>("banner");
const recentSelect = $<HTMLSelectElement>("recent");
const pathEl = $<HTMLElement>("workspace-path");
const syncEl = $<HTMLElement>("sync-status");
const refreshButton = $<HTMLButtonElement>("refresh");
const filtersForm = $<HTMLFormElement>("filters");
const searchInput = $<HTMLInputElement>("search");
const typeSelect = $<HTMLSelectElement>("filter-type");
const prioritySelect = $<HTMLSelectElement>("filter-priority");
const assigneeSelect = $<HTMLSelectElement>("filter-assignee");
const labelSelect = $<HTMLSelectElement>("filter-label");
const epicSelect = $<HTMLSelectElement>("filter-epic");
const doneSelect = $<HTMLSelectElement>("filter-done");
const clearFiltersButton = $<HTMLButtonElement>("clear-filters");

// Workspace lifecycle

async function chooseFolder(): Promise<void> {
  let picked: string | null;
  try {
    picked = await open({
      directory: true,
      multiple: false,
      title: "Open a folder with a beads database",
      defaultPath: state.root ?? undefined,
    });
  } catch (error) {
    showBanner(`Couldn't show the folder picker: ${message(error)}`);
    return;
  }
  if (typeof picked === "string") await openFolder(picked);
}

async function openFolder(root: string): Promise<void> {
  const generation = ++state.generation;
  setSync("Opening…", true);
  try {
    const workspace = await openWorkspace(root);
    if (generation !== state.generation) return;
    const pattern = issueRefPattern(workspace.prefix);
    Object.assign(state, {
      root,
      workspace,
      data: null,
      signature: "",
      issuesById: new Map(),
      progress: new Map(),
      refs: pattern ? { pattern, isKnown: (id: string) => state.issuesById.has(id) } : null,
      filters: { ...DEFAULT_FILTERS, doneDays: state.filters.doneDays },
      marker: null,
    });
    closeGraph();
    closeDetail();
    writeFilterControls();
    rememberRecent(root);
    pathEl.textContent = root;
    pathEl.title = root;
    // Tells windows apart in the Window menu and the app switcher.
    void getCurrentWindow().setTitle(`${folderName(root)} — ${APP_TITLE}`);
    showBanner(null);
    emptyEl.hidden = true;
    boardEl.hidden = false;
    boardEl.replaceChildren(el("p", { class: "board-message" }, "Loading issues…"));
    await refresh();
  } catch (error) {
    if (generation !== state.generation) return;
    setSync("");
    renderRecents();
    showBanner(`Couldn't open ${root}: ${message(error)}`);
    if (!state.workspace) showEmpty();
  }
}

let pending: { generation: number; promise: Promise<void> } | null = null;

/** Reloads the board, joining a reload of the same workspace that is already running. */
function refresh(): Promise<void> {
  if (pending?.generation !== state.generation) {
    const generation = state.generation;
    const promise = reload(generation).finally(() => {
      if (pending?.promise === promise) pending = null;
    });
    pending = { generation, promise };
  }
  return pending.promise;
}

async function reload(generation: number): Promise<void> {
  const { root, workspace } = state;
  if (!root || !workspace) return;
  setSync("Refreshing…", true);
  try {
    // Read the marker first: a write that lands during the load moves it again.
    const marker = await changeMarker(workspace.beads_dir);
    state.marker = marker;
    state.checkedAt = Date.now();
    const data = await loadBoard(root);
    if (generation !== state.generation) return;
    applyData(data);
    showBanner(null);
    setSync(`Updated ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    if (generation !== state.generation) return;
    state.checkedAt = Date.now();
    showBanner(`Couldn't load issues: ${message(error)}`, true);
    setSync("Refresh failed");
  }
}

function applyData(data: BoardData): void {
  const signature = JSON.stringify(data);
  const changed = signature !== state.signature;
  if (changed) {
    state.data = data;
    state.signature = signature;
    state.issuesById = new Map(data.issues.map((issue) => [issue.id, issue]));
    state.progress = childProgress(data.issues, categories());
    updateFilterOptions();
  }
  // Re-render even when nothing changed, so relative times stay current.
  renderBoard();
  if (changed && state.graphRootId) renderGraphView();
  if (changed && state.selectedId) {
    renderDetailPanel();
    void fetchDetail(state.selectedId);
  }
}

function showEmpty(): void {
  boardEl.hidden = true;
  boardEl.replaceChildren();
  emptyEl.hidden = false;
}

/** Vite also serves the page to ordinary browsers, which have no backend to run bd. */
function showBrowserOnly(): void {
  $<HTMLElement>("toolbar").hidden = true;
  emptyEl.replaceChildren(
    el("h1", {}, "Open this in the app window"),
    el(
      "p",
      {},
      "This page is the ASDLC Dashboard's frontend. It reads beads through the desktop app, " +
        "so it can't load issues in a browser. Run ",
      el("code", {}, "pnpm tauri dev"),
      " and use the window it opens.",
    ),
  );
  showEmpty();
}

// Board

function categories(): Record<string, StatusCategory> {
  return state.workspace?.status_categories ?? {};
}

function renderBoard(): void {
  if (!state.data) return;
  const now = new Date();
  renderColumns(
    boardEl,
    visibleColumns(buildColumns(state.data, categories(), state.filters, now)),
    {
      categories: categories(),
      blockedBy: state.data.blocked_by,
      progress: state.progress,
      selectedId: state.selectedId,
      now,
    },
    state.filters.doneDays,
  );
  const { text, type, priority, assignee, label, epic } = state.filters;
  clearFiltersButton.hidden = !(text || type || priority || assignee || label || epic);
}

function markSelected(): void {
  for (const item of document.querySelectorAll<HTMLElement>(".card, .graph-node")) {
    item.classList.toggle("selected", item.dataset.issue === state.selectedId);
  }
}

// Filters

function readFilterControls(): void {
  state.filters = {
    text: searchInput.value,
    type: typeSelect.value,
    priority: prioritySelect.value,
    assignee: assigneeSelect.value,
    label: labelSelect.value,
    epic: epicSelect.value,
    doneDays: Number(doneSelect.value),
  };
}

function writeFilterControls(): void {
  searchInput.value = state.filters.text;
  typeSelect.value = state.filters.type;
  prioritySelect.value = state.filters.priority;
  assigneeSelect.value = state.filters.assignee;
  labelSelect.value = state.filters.label;
  epicSelect.value = state.filters.epic;
  doneSelect.value = String(state.filters.doneDays);
}

function updateFilterOptions(): void {
  const options = filterOptions(state.data?.issues ?? [], categories());
  setOptions(typeSelect, [["", "All types"], ...options.types.map(same)]);
  setOptions(assigneeSelect, [
    ["", "Anyone"],
    [UNASSIGNED, "Unassigned"],
    ...options.assignees.map(same),
  ]);
  setOptions(labelSelect, [["", "All labels"], ...options.labels.map(same)]);
  setOptions(epicSelect, [
    ["", "All epics"],
    ...options.epics.map((epic): [string, string] => [
      epic.id,
      `${categories()[epic.status] === "done" ? "✓ " : ""}${epic.id} · ${truncate(epic.title, 60)}`,
    ]),
  ]);
  // A selected option that no longer exists falls back to "all".
  readFilterControls();
}

function setOptions(select: HTMLSelectElement, options: [value: string, label: string][]): void {
  const value = select.value;
  select.replaceChildren(...options.map(([v, label]) => el("option", { value: v }, label)));
  select.value = options.some(([v]) => v === value) ? value : "";
}

function onFiltersChanged(): void {
  readFilterControls();
  storeDoneDays(state.filters.doneDays);
  renderBoard();
}

function clearFilters(): void {
  state.filters = { ...DEFAULT_FILTERS, doneDays: state.filters.doneDays };
  writeFilterControls();
  renderBoard();
}

// Detail panel

async function selectIssue(id: string): Promise<void> {
  if (!state.root) return;
  const switching = id !== state.selectedId;
  state.selectedId = id;
  if (switching || state.detail?.status !== "loaded") state.detail = { status: "loading" };
  markSelected();
  renderDetailPanel(switching);
  // The panel takes room from the graph, which can cover the issue just clicked.
  graphNode(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  await fetchDetail(id);
}

async function fetchDetail(id: string): Promise<void> {
  const { root, generation } = state;
  if (!root) return;
  let next: DetailState;
  try {
    next = { status: "loaded", detail: await loadIssue(root, id) };
  } catch (error) {
    next = { status: "failed", error: message(error) };
  }
  if (state.selectedId !== id || state.generation !== generation) return;
  // Keep showing what was loaded before if a background reload fails.
  if (next.status === "failed" && state.detail?.status === "loaded") return;
  state.detail = next;
  renderDetailPanel();
}

function renderDetailPanel(resetScroll = false): void {
  const id = state.selectedId;
  if (!id || !state.detail) return;
  // An issue the list leaves out (another workspace's, for example) is drawn from bd show alone.
  const loaded = state.detail.status === "loaded" ? state.detail.detail : null;
  const issue =
    state.issuesById.get(id) ?? (loaded ? { ...loaded, dependencies: undefined } : null);
  const previousBody = detailEl.querySelector<HTMLElement>(".detail-body");
  const scrollTop = resetScroll ? 0 : (previousBody?.scrollTop ?? 0);
  detailEl.replaceChildren(
    ...(issue
      ? renderDetail(issue, state.detail, detailContext())
      : [el("p", { class: "board-message" }, state.detail.status === "failed" ? state.detail.error : "Loading…")]),
  );
  detailEl.hidden = false;
  const body = detailEl.querySelector<HTMLElement>(".detail-body");
  if (body) body.scrollTop = scrollTop;
}

function detailContext(): DetailContext {
  return {
    issuesById: state.issuesById,
    blockedBy: state.data?.blocked_by ?? {},
    progress: state.progress,
    categories: categories(),
    refs: state.refs,
    now: new Date(),
  };
}

function closeDetail(refocus = true): void {
  const id = state.selectedId;
  state.selectedId = null;
  state.detail = null;
  detailEl.hidden = true;
  detailEl.replaceChildren();
  markSelected();
  if (id && refocus) {
    (graphNode(id) ?? boardEl.querySelector<HTMLElement>(`.card[data-issue="${CSS.escape(id)}"]`))?.focus();
  }
}

/** Elements that do something when clicked, so a click on them leaves the details panel open. */
const CLICKABLE = "a, button, input, select, textarea, label, [data-action], [data-issue]";

/**
 * Whether a click here closes the details panel: outside it, and on nothing clickable.
 * An element a reload has since replaced can't be placed, so it keeps the panel open.
 */
function closesDetail(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.isConnected &&
    !detailEl.contains(target) &&
    !target.closest(CLICKABLE)
  );
}

async function copyId(button: HTMLElement): Promise<void> {
  const id = button.dataset.id ?? "";
  const label = button.firstChild;
  try {
    await navigator.clipboard.writeText(id);
    if (label) label.textContent = "Copied";
  } catch {
    if (label) label.textContent = "Copy failed";
  }
  setTimeout(() => {
    if (label) label.textContent = id;
  }, 1200);
}

// Dependency graph

function openGraph(id: string): void {
  // Rather than an empty graph, show the other way: an epic usually has children but no dependencies.
  const issues = state.data?.issues ?? [];
  const other: GraphDirection =
    state.graphDirection === "dependencies" ? "dependents" : "dependencies";
  if (
    buildGraph(id, issues, state.graphDirection).links.length === 0 &&
    buildGraph(id, issues, other).links.length > 0
  ) {
    state.graphDirection = other;
  }
  state.graphRootId = id;
  graphEl.hidden = false;
  renderGraphView(true);
  graphNode(id)?.focus({ preventScroll: true });
}

function setGraphDirection(direction: GraphDirection): void {
  if (direction === state.graphDirection) return;
  state.graphDirection = direction;
  renderGraphView(true);
}

/** Draws the graph, keeping its scroll position and focus unless `reset` brings the root into view. */
function renderGraphView(reset = false): void {
  const rootId = state.graphRootId;
  if (!rootId) return;
  const scroller = graphEl.querySelector<HTMLElement>(".graph-scroll");
  const scroll = scroller && { top: scroller.scrollTop, left: scroller.scrollLeft };
  const focused = document.activeElement;
  const refocus =
    focused instanceof HTMLElement && graphEl.contains(focused) ? sameControl(focused) : null;

  graphEl.replaceChildren(
    ...renderGraph(rootId, state.graphDirection, {
      issues: state.data?.issues ?? [],
      issuesById: state.issuesById,
      categories: categories(),
      selectedId: state.selectedId,
    }),
  );

  const next = graphEl.querySelector<HTMLElement>(".graph-scroll");
  if (reset) {
    graphNode(rootId)?.scrollIntoView({ block: "center", inline: "nearest" });
  } else if (next && scroll) {
    next.scrollTop = scroll.top;
    next.scrollLeft = scroll.left;
  }
  if (refocus) graphEl.querySelector<HTMLElement>(refocus)?.focus({ preventScroll: true });
}

/** A selector for the same control once the graph is drawn again. */
function sameControl(element: HTMLElement): string | null {
  const { issue, direction, action } = element.dataset;
  if (issue) return `.graph-node[data-issue="${CSS.escape(issue)}"]`;
  if (direction) return `[data-direction="${CSS.escape(direction)}"]`;
  if (action) return `[data-action="${CSS.escape(action)}"]`;
  return null;
}

function closeGraph(): void {
  const id = state.graphRootId;
  if (!id) return;
  state.graphRootId = null;
  graphEl.hidden = true;
  graphEl.replaceChildren();
  // Back to where the graph was opened: the details panel, or the board if that has closed.
  (
    detailEl.querySelector<HTMLElement>('[data-action="open-graph"]') ??
    boardEl.querySelector<HTMLElement>(`.card[data-issue="${CSS.escape(id)}"]`)
  )?.focus();
}

function graphNode(id: string): HTMLElement | null {
  return graphEl.querySelector<HTMLElement>(`.graph-node[data-issue="${CSS.escape(id)}"]`);
}

// Windows and zoom

async function newWindow(): Promise<void> {
  try {
    await invoke("new_window");
  } catch (error) {
    showBanner(`Couldn't open a new window: ${message(error)}`);
  }
}

function zoomBy(steps: number): void {
  const index = ZOOM_LEVELS.indexOf(state.zoom) + steps;
  setZoom(ZOOM_LEVELS[Math.min(Math.max(index, 0), ZOOM_LEVELS.length - 1)]);
}

function setZoom(level: number): void {
  if (level === state.zoom) return;
  state.zoom = level;
  applyZoom();
  try {
    localStorage.setItem(ZOOM_KEY, String(level));
  } catch {
    // The zoom just won't outlast the window.
  }
}

function applyZoom(): void {
  void getCurrentWebview().setZoom(state.zoom);
}

// Status line

function setSync(text: string, busy = false): void {
  syncEl.textContent = text;
  refreshButton.classList.toggle("spinning", busy);
}

function showBanner(text: string | null, retry = false): void {
  bannerEl.hidden = text === null;
  if (text === null) return;
  const parts: Node[] = [el("span", { class: "banner-text" }, text)];
  if (retry) {
    parts.push(el("button", { type: "button", class: "button", "data-action": "refresh" }, "Retry"));
  }
  parts.push(
    el(
      "button",
      { type: "button", class: "icon-button", "data-action": "dismiss-banner", "aria-label": "Dismiss" },
      icon("close"),
    ),
  );
  bannerEl.replaceChildren(...parts);
}

// Recent workspaces

function recents(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(root: string): void {
  const next = [root, ...recents().filter((path) => path !== root)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Without storage the app just won't remember the folder.
  }
  renderRecents();
}

function renderRecents(): void {
  const paths = recents();
  const names = paths.map(folderName);
  recentSelect.replaceChildren(
    ...(state.root ? [] : [el("option", { value: "", disabled: true }, "Recent folders")]),
    ...paths.map((path, i) =>
      el(
        "option",
        { value: path, title: path },
        // Two folders with the same name are told apart by their parent.
        names.indexOf(names[i]) !== names.lastIndexOf(names[i]) ? parentAndName(path) : names[i],
      ),
    ),
  );
  recentSelect.value = state.root ?? "";
  recentSelect.hidden = paths.length === 0;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function parentAndName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}

// Preferences and helpers

function storedDoneDays(): number {
  try {
    const stored = localStorage.getItem(DONE_DAYS_KEY);
    return stored !== null && DONE_DAY_CHOICES.includes(Number(stored))
      ? Number(stored)
      : DEFAULT_FILTERS.doneDays;
  } catch {
    return DEFAULT_FILTERS.doneDays;
  }
}

function storedZoom(): number {
  try {
    const stored = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOM_LEVELS.includes(stored) ? stored : 1;
  } catch {
    return 1;
  }
}

function storeDoneDays(days: number): void {
  try {
    localStorage.setItem(DONE_DAYS_KEY, String(days));
  } catch {
    // Not remembering the preference is harmless.
  }
}

function same(value: string): [string, string] {
  return [value, value];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

// Events

/** Where the latest click began. */
let pressTarget: EventTarget | null = null;
document.addEventListener("pointerdown", (event) => {
  pressTarget = event.target;
});

document.addEventListener("click", (event) => {
  const target = event.target as Element;
  const action = target.closest<HTMLElement>("[data-action]");
  if (action) {
    event.preventDefault();
    switch (action.dataset.action) {
      case "open-folder":
        void chooseFolder();
        break;
      case "refresh":
        void refresh();
        break;
      case "new-window":
        void newWindow();
        break;
      case "close-detail":
        closeDetail();
        break;
      case "copy-id":
        void copyId(action);
        break;
      case "open-graph":
        openGraph(action.dataset.id!);
        break;
      case "graph-direction":
        setGraphDirection(action.dataset.direction as GraphDirection);
        break;
      case "close-graph":
        closeGraph();
        break;
      case "clear-filters":
        clearFilters();
        break;
      case "dismiss-banner":
        showBanner(null);
        break;
    }
    return;
  }
  const issueTarget = target.closest<HTMLElement>("[data-issue]");
  if (issueTarget) {
    event.preventDefault();
    void selectIssue(issueTarget.dataset.issue!);
    return;
  }
  // Links in issue text open in the browser, never inside the app's window.
  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (link) {
    event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) void openUrl(href);
    return;
  }
  // Checking where the press began too keeps a drag out of the panel, such as a text
  // selection, from closing it. The mouse user's focus stays put, so no card takes it.
  if (state.selectedId && closesDetail(target) && closesDetail(pressTarget)) closeDetail(false);
});

/** ⌘ (or Ctrl) shortcuts, keyed by `event.key`. */
const SHORTCUTS = new Map<string, () => void>([
  ["r", () => void refresh()],
  ["o", () => void chooseFolder()],
  ["n", () => void newWindow()],
  ["=", () => zoomBy(1)],
  ["+", () => zoomBy(1)],
  ["-", () => zoomBy(-1)],
  ["0", () => setZoom(1)],
]);

document.addEventListener("keydown", (event) => {
  const shortcut = (event.metaKey || event.ctrlKey) && SHORTCUTS.get(event.key.toLowerCase());
  if (shortcut) {
    event.preventDefault();
    shortcut();
    return;
  }
  if (event.key === "Escape") {
    if (event.target === searchInput && searchInput.value) {
      searchInput.value = "";
      onFiltersChanged();
    } else if (state.selectedId) {
      closeDetail();
    } else if (state.graphRootId) {
      closeGraph();
    } else if (isTyping(event.target)) {
      (event.target as HTMLElement).blur();
    }
    return;
  }
  if (isTyping(event.target)) return;
  // The filter is under the graph and doesn't apply to it.
  if (event.key === "/" && !state.graphRootId) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  const card = (event.target as Element).closest?.<HTMLElement>(".card");
  if (card && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    void selectIssue(card.dataset.issue!);
  }
});

// A mouse wheel only turns up and down; where that scrolls nothing, it scrolls sideways.
// Not passive, so the wheel's own scrolling can be cancelled.
boardEl.addEventListener("wheel", (event) => scrollSideways(event, boardEl), { passive: false });
graphEl.addEventListener(
  "wheel",
  (event) => {
    const scroller = (event.target as Element).closest<HTMLElement>(".graph-scroll");
    if (scroller) scrollSideways(event, scroller);
  },
  { passive: false },
);

filtersForm.addEventListener("input", onFiltersChanged);
filtersForm.addEventListener("submit", (event) => event.preventDefault());
recentSelect.addEventListener("change", () => {
  if (recentSelect.value && recentSelect.value !== state.root) void openFolder(recentSelect.value);
});

setInterval(async () => {
  const { workspace } = state;
  if (!workspace || pending || document.hidden) return;
  if (Date.now() - state.checkedAt > FULL_REFRESH_MS) {
    void refresh();
    return;
  }
  try {
    const marker = await changeMarker(workspace.beads_dir);
    if (workspace === state.workspace && marker !== state.marker) void refresh();
  } catch {
    // The next tick tries again.
  }
}, WATCH_INTERVAL_MS);

window.addEventListener("focus", () => {
  if (state.workspace && Date.now() - state.checkedAt > FOCUS_REFRESH_MS) void refresh();
});

// Another window changed a shared preference.
window.addEventListener("storage", (event) => {
  if (event.key === RECENTS_KEY) {
    renderRecents();
  } else if (event.key === ZOOM_KEY) {
    state.zoom = storedZoom();
    applyZoom();
  }
});

// Start

$<HTMLButtonElement>("open-folder").prepend(icon("folder"));
$<HTMLButtonElement>("empty-open").prepend(icon("folder"));
refreshButton.append(icon("refresh"));
$<HTMLButtonElement>("new-window").append(icon("new-window"));
$<HTMLElement>("search-icon").append(icon("search"));
writeFilterControls();
if (!isTauri()) {
  showBrowserOnly();
} else {
  if (state.zoom !== 1) applyZoom();
  renderRecents();
  // Only the first window reopens the last folder; a new window is for another one.
  const [lastFolder] = recents();
  if (lastFolder && getCurrentWindow().label === "main") void openFolder(lastFolder);
  else showEmpty();
}
