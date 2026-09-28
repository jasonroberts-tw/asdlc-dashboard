import type { BoardData, Issue, StatusCategory } from "./beads";

export type ColumnId = "hold" | "blocked" | "ready" | "active" | "done";

export interface ColumnSpec {
  id: ColumnId;
  title: string;
  hint: string;
}

export const COLUMNS: readonly ColumnSpec[] = [
  { id: "hold", title: "On hold", hint: "Deferred or pinned" },
  { id: "blocked", title: "Blocked", hint: "Waiting on an open issue" },
  { id: "ready", title: "Ready", hint: "Open, with nothing blocking it" },
  { id: "active", title: "In progress", hint: "Being worked on" },
  { id: "done", title: "Done", hint: "Closed" },
];

/** Assignee filter value for issues with no assignee. */
export const UNASSIGNED = ":unassigned";

export interface Filters {
  /** Whitespace-separated terms, all of which must match. */
  text: string;
  type: string;
  priority: string;
  assignee: string;
  /** Show only this issue and its descendants. */
  epic: string;
  /** Hide issues closed longer ago than this; 0 shows every closed issue. */
  doneDays: number;
}

export const DEFAULT_FILTERS: Filters = {
  text: "",
  type: "",
  priority: "",
  assignee: "",
  epic: "",
  doneDays: 7,
};

export interface Column extends ColumnSpec {
  issues: Issue[];
  /** Closed issues that match the filters but fall outside the done window. */
  hidden: number;
}

export interface Progress {
  done: number;
  total: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function columnFor(
  issue: Issue,
  categories: Record<string, StatusCategory>,
  blockedBy: Record<string, string[]>,
): ColumnId {
  // The built-in "blocked" status is in the wip category, but it belongs with the blocked issues.
  if (issue.status === "blocked") return "blocked";
  switch (categories[issue.status]) {
    case "done":
      return "done";
    case "frozen":
      return "hold";
    case "wip":
      return "active";
    default:
      return blockedBy[issue.id]?.length ? "blocked" : "ready";
  }
}

export function buildColumns(
  data: BoardData,
  categories: Record<string, StatusCategory>,
  filters: Filters,
  now: Date,
): Column[] {
  const terms = filters.text.toLowerCase().split(/\s+/).filter(Boolean);
  const inEpic = filters.epic ? descendantsOf(filters.epic, data.issues) : null;
  const doneSince =
    filters.doneDays > 0 ? now.getTime() - filters.doneDays * DAY_MS : null;

  const columns = new Map<ColumnId, Column>(
    COLUMNS.map((spec) => [spec.id, { ...spec, issues: [], hidden: 0 }]),
  );
  for (const issue of data.issues) {
    if (inEpic && !inEpic.has(issue.id)) continue;
    if (!matchesFilters(issue, filters, terms)) continue;
    const column = columns.get(columnFor(issue, categories, data.blocked_by))!;
    if (
      column.id === "done" &&
      doneSince !== null &&
      Date.parse(issue.closed_at ?? issue.updated_at) < doneSince
    ) {
      column.hidden++;
      continue;
    }
    column.issues.push(issue);
  }
  for (const column of columns.values()) {
    column.issues.sort(column.id === "done" ? byClosedDesc : byPriorityThenUpdated);
  }
  return [...columns.values()];
}

function matchesFilters(issue: Issue, filters: Filters, terms: string[]): boolean {
  if (filters.type && issue.issue_type !== filters.type) return false;
  if (filters.priority && String(issue.priority) !== filters.priority) return false;
  if (filters.assignee) {
    const assignee = issue.assignee ?? UNASSIGNED;
    if (assignee !== filters.assignee) return false;
  }
  if (terms.length === 0) return true;
  const haystack = [
    issue.id,
    issue.title,
    issue.issue_type,
    issue.assignee ?? "",
    ...(issue.labels ?? []),
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** The issue itself plus every issue under it through `parent` links. */
export function descendantsOf(rootId: string, issues: Issue[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const issue of issues) {
    if (!issue.parent) continue;
    const siblings = children.get(issue.parent) ?? [];
    siblings.push(issue.id);
    children.set(issue.parent, siblings);
  }
  const found = new Set([rootId]);
  const pending = [rootId];
  while (pending.length > 0) {
    for (const child of children.get(pending.pop()!) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      pending.push(child);
    }
  }
  return found;
}

/** Closed and total direct children for every issue that has children. */
export function childProgress(
  issues: Issue[],
  categories: Record<string, StatusCategory>,
): Map<string, Progress> {
  const progress = new Map<string, Progress>();
  for (const issue of issues) {
    if (!issue.parent) continue;
    const counts = progress.get(issue.parent) ?? { done: 0, total: 0 };
    counts.total++;
    if (categories[issue.status] === "done") counts.done++;
    progress.set(issue.parent, counts);
  }
  return progress;
}

export interface FilterOptions {
  types: string[];
  assignees: string[];
  /** Open epics first, then closed ones. */
  epics: Issue[];
}

export function filterOptions(
  issues: Issue[],
  categories: Record<string, StatusCategory>,
): FilterOptions {
  const types = new Set<string>();
  const assignees = new Set<string>();
  for (const issue of issues) {
    types.add(issue.issue_type);
    if (issue.assignee) assignees.add(issue.assignee);
  }
  const isDone = (issue: Issue) => categories[issue.status] === "done";
  const epics = issues
    .filter((issue) => issue.issue_type === "epic")
    .sort(
      (a, b) =>
        Number(isDone(a)) - Number(isDone(b)) ||
        a.priority - b.priority ||
        a.id.localeCompare(b.id),
    );
  return {
    types: [...types].sort(),
    assignees: [...assignees].sort((a, b) => a.localeCompare(b)),
    epics,
  };
}

function byPriorityThenUpdated(a: Issue, b: Issue): number {
  return a.priority - b.priority || b.updated_at.localeCompare(a.updated_at);
}

function byClosedDesc(a: Issue, b: Issue): number {
  return (b.closed_at ?? b.updated_at).localeCompare(a.closed_at ?? a.updated_at);
}
