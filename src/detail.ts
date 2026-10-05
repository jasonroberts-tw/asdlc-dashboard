import type { Comment, Issue, IssueDetail, StatusCategory } from "./beads";
import type { Progress } from "./board";
import { cls, el, icon, token } from "./dom";
import { features } from "./features";
import { dateTime, humanize, leaseExpired, relativeTime } from "./format";
import { renderMarkdown, type IssueRefs } from "./markdown";
import { priorityChip, progressBar, statusChip, typeChip } from "./render";

export interface DetailContext {
  issuesById: Map<string, Issue>;
  blockedBy: Record<string, string[]>;
  progress: Map<string, Progress>;
  categories: Record<string, StatusCategory>;
  refs: IssueRefs | null;
  now: Date;
}

/** Comments and dependents come from `bd show`, which runs after the panel first opens. */
export type DetailState =
  | { status: "loading" }
  | { status: "loaded"; detail: IssueDetail }
  | { status: "failed"; error: string };

/** Headings for an issue's own links (`bd show` wording), keyed by dependency type. */
const OUTBOUND: Record<string, string> = {
  blocks: "Depends on",
  "parent-child": "Parent",
  "discovered-from": "Discovered from",
  related: "Related",
  "relates-to": "Related",
  supersedes: "Superseded by",
  duplicates: "Duplicate of",
};

/** Headings for links other issues make to this one. */
const INBOUND: Record<string, string> = {
  blocks: "Blocks",
  "parent-child": "Children",
  "discovered-from": "Discovered while working on this",
  related: "Related",
  "relates-to": "Related",
  supersedes: "Supersedes",
  duplicates: "Duplicated by",
};

interface Relation {
  id: string;
  title?: string;
  status?: string;
}

export function renderDetail(
  issue: Issue,
  state: DetailState,
  ctx: DetailContext,
): HTMLElement[] {
  const progress = ctx.progress.get(issue.id);
  const blockers = ctx.blockedBy[issue.id] ?? [];
  return [
    el(
      "header",
      { class: "detail-header" },
      el(
        "div",
        { class: "detail-chips" },
        typeChip(issue.issue_type),
        priorityChip(issue.priority),
        statusChip(issue.status, ctx.categories[issue.status]),
      ),
      el(
        "button",
        {
          type: "button",
          class: "detail-id",
          "data-action": "copy-id",
          "data-id": issue.id,
          title: "Copy ID",
        },
        issue.id,
        icon("copy"),
      ),
      el(
        "button",
        {
          type: "button",
          class: "button",
          "data-action": "open-graph",
          "data-id": issue.id,
          title: "Show this issue's dependency graph",
        },
        icon("graph"),
        "Graph",
      ),
      el(
        "button",
        {
          type: "button",
          class: "icon-button",
          "data-action": "close-detail",
          "aria-label": "Close details",
          title: "Close (Esc)",
        },
        icon("close"),
      ),
    ),
    el(
      "div",
      { class: "detail-body" },
      el("h2", { class: "detail-title" }, issue.title),
      metaList(issue, ctx),
      progress && progressBar(progress),
      blockers.length > 0 &&
        section(
          "Blocked by",
          relationList(blockers.map((id) => relation(id, ctx)), ctx),
          "detail-blocked",
        ),
      textSection("Description", issue.description, ctx),
      textSection("Design", issue.design, ctx),
      textSection("Acceptance criteria", issue.acceptance_criteria, ctx),
      textSection("Notes", issue.notes, ctx),
      textSection("Close reason", issue.close_reason, ctx),
      relationsSection(issue, state, ctx),
      commentsSection(issue, state, ctx),
    ),
  ];
}

function metaList(issue: Issue, ctx: DetailContext): HTMLElement {
  const parent = issue.parent ? relation(issue.parent, ctx) : null;
  const rows: [string, Node | string | null][] = [
    ["Assignee", issue.assignee ?? "Unassigned"],
    ["Owner", issue.owner ?? null],
    ["Parent", parent && relationLink(parent, ctx)],
    ["Labels", issue.labels?.length ? labelList(issue.labels) : null],
    ["Created", timeWithActor(issue.created_at, issue.created_by, ctx.now)],
    ["Updated", time(issue.updated_at, ctx.now)],
    ["Started", issue.started_at ? time(issue.started_at, ctx.now) : null],
    ["Closed", issue.closed_at ? time(issue.closed_at, ctx.now) : null],
    ["Deferred until", issue.defer_until ? time(issue.defer_until, ctx.now) : null],
    [
      "Lease expires",
      features.leases && issue.lease_expires_at
        ? el(
            "span",
            { class: cls(leaseExpired(issue, ctx.now) && "warn") },
            time(issue.lease_expires_at, ctx.now),
          )
        : null,
    ],
  ];
  return el(
    "dl",
    { class: "detail-meta" },
    rows
      .filter(([, value]) => value !== null)
      .map(([term, value]) => [el("dt", {}, term), el("dd", {}, value)])
      .flat(),
  );
}

function relationsSection(issue: Issue, state: DetailState, ctx: DetailContext): HTMLElement | null {
  const groups = new Map<string, Relation[]>();
  const add = (heading: string, item: Relation) => {
    const items = groups.get(heading) ?? [];
    items.push(item);
    groups.set(heading, items);
  };

  if (state.status === "loaded") {
    for (const dep of state.detail.dependencies ?? []) {
      if (dep.dependency_type === "parent-child") continue;
      add(OUTBOUND[dep.dependency_type] ?? humanize(dep.dependency_type), dep);
    }
    for (const dep of state.detail.dependents ?? []) {
      add(INBOUND[dep.dependency_type] ?? `${humanize(dep.dependency_type)} (from)`, dep);
    }
  } else {
    // Until bd show answers, fall back to the links the list already carries.
    for (const dep of issue.dependencies ?? []) {
      if (dep.type === "parent-child" || dep.issue_id !== issue.id) continue;
      add(OUTBOUND[dep.type] ?? humanize(dep.type), relation(dep.depends_on_id, ctx));
    }
  }

  const note =
    state.status === "loading"
      ? el("p", { class: "muted" }, "Loading linked issues…")
      : state.status === "failed"
        ? el("p", { class: "error-text" }, state.error)
        : null;
  if (groups.size === 0 && !note) return null;
  return section(
    "Links",
    [...groups].map(([heading, items]) =>
      el("div", { class: "relation-group" }, el("h4", {}, heading), relationList(items, ctx)),
    ),
    null,
    note,
  );
}

function commentsSection(issue: Issue, state: DetailState, ctx: DetailContext): HTMLElement | null {
  const count = issue.comment_count ?? 0;
  if (state.status === "loaded") {
    const comments = state.detail.comments ?? [];
    if (comments.length === 0) return null;
    return section(`Comments (${comments.length})`, comments.map((c) => renderComment(c, ctx)));
  }
  if (count === 0) return null;
  return section(
    `Comments (${count})`,
    state.status === "loading"
      ? el("p", { class: "muted" }, "Loading comments…")
      : el("p", { class: "error-text" }, state.error),
  );
}

function renderComment(comment: Comment, ctx: DetailContext): HTMLElement {
  return el(
    "article",
    { class: "comment" },
    el(
      "header",
      {},
      el("strong", {}, comment.author),
      el(
        "time",
        { datetime: comment.created_at, title: dateTime(comment.created_at) },
        relativeTime(comment.created_at, ctx.now),
      ),
    ),
    renderMarkdown(comment.text, ctx.refs),
  );
}

function textSection(heading: string, text: string | undefined, ctx: DetailContext) {
  if (!text?.trim()) return null;
  return section(heading, renderMarkdown(text, ctx.refs));
}

function section(
  heading: string,
  content: Node | Node[],
  className: string | null = null,
  after: Node | null = null,
): HTMLElement {
  return el("section", { class: cls("detail-section", className) }, el("h3", {}, heading), content, after);
}

function relation(id: string, ctx: DetailContext): Relation {
  const known = ctx.issuesById.get(id);
  return { id, title: known?.title, status: known?.status };
}

function relationList(items: Relation[], ctx: DetailContext): HTMLElement {
  return el(
    "ul",
    { class: "relations" },
    items.map((item) => el("li", {}, relationLink(item, ctx))),
  );
}

function relationLink(item: Relation, ctx: DetailContext): HTMLElement {
  const category = item.status ? ctx.categories[item.status] : undefined;
  return el(
    "a",
    { href: "#", class: "relation", "data-issue": item.id, title: item.status ?? "" },
    el("span", {
      class: cls("status-dot", `status-${token(category ?? "unknown")}`),
      "aria-hidden": "true",
    }),
    el("span", { class: "relation-id" }, item.id),
    item.title && el("span", { class: "relation-title" }, item.title),
  );
}

function labelList(labels: string[]): HTMLElement {
  return el(
    "span",
    { class: "card-labels" },
    labels.map((label) => el("span", { class: "label" }, label)),
  );
}

function time(iso: string, now: Date): HTMLElement {
  return el("time", { datetime: iso, title: relativeTime(iso, now) }, dateTime(iso));
}

function timeWithActor(iso: string, actor: string | undefined, now: Date): HTMLElement {
  return el("span", {}, time(iso, now), actor && ` by ${actor}`);
}
