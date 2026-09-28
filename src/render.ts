import type { Issue, StatusCategory } from "./beads";
import type { Column, ColumnId, Progress } from "./board";
import { cls, el, icon, token } from "./dom";
import { dateTime, initials, leaseExpired, relativeTime } from "./format";

export interface BoardContext {
  categories: Record<string, StatusCategory>;
  blockedBy: Record<string, string[]>;
  progress: Map<string, Progress>;
  selectedId: string | null;
  now: Date;
}

/** Replaces the columns, keeping each column's scroll position and the focused card. */
export function renderColumns(
  board: HTMLElement,
  columns: Column[],
  ctx: BoardContext,
  doneDays: number,
): void {
  const scroll = new Map<string, number>();
  for (const body of board.querySelectorAll<HTMLElement>(".column-body")) {
    scroll.set(body.dataset.column!, body.scrollTop);
  }
  const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
    ".card",
  )?.dataset.issue;

  board.replaceChildren(...columns.map((column) => renderColumn(column, ctx, doneDays)));

  for (const body of board.querySelectorAll<HTMLElement>(".column-body")) {
    body.scrollTop = scroll.get(body.dataset.column!) ?? 0;
  }
  if (focusedId) {
    board.querySelector<HTMLElement>(`.card[data-issue="${CSS.escape(focusedId)}"]`)?.focus();
  }
}

function renderColumn(column: Column, ctx: BoardContext, doneDays: number): HTMLElement {
  const headingId = `column-${column.id}`;
  return el(
    "section",
    {
      class: cls("column", `column-${column.id}`, column.issues.length === 0 && "is-empty"),
      "aria-labelledby": headingId,
    },
    el(
      "header",
      { class: "column-header", title: column.hint },
      el("h2", { id: headingId }, column.title),
      el("span", { class: "count" }, column.issues.length),
    ),
    el(
      "div",
      { class: "column-body", "data-column": column.id },
      column.issues.length > 0
        ? column.issues.map((issue) => renderCard(issue, column.id, ctx))
        : el("p", { class: "column-empty" }, "Nothing here"),
      column.hidden > 0 &&
        el(
          "p",
          { class: "column-note" },
          `${column.hidden} closed more than ${doneDays === 1 ? "a day" : `${doneDays} days`} ago`,
        ),
    ),
  );
}

function renderCard(issue: Issue, columnId: ColumnId, ctx: BoardContext): HTMLElement {
  const blockers = ctx.blockedBy[issue.id] ?? [];
  const progress = ctx.progress.get(issue.id);
  const labels = issue.labels ?? [];
  const comments = issue.comment_count ?? 0;
  const when = cardTime(issue, columnId, ctx.now);
  return el(
    "article",
    {
      class: cls("card", issue.id === ctx.selectedId && "selected"),
      "data-issue": issue.id,
      "data-priority": issue.priority,
      tabindex: 0,
      role: "button",
      "aria-label": `${issue.id}: ${issue.title}`,
    },
    el(
      "div",
      { class: "card-top" },
      typeChip(issue.issue_type),
      priorityChip(issue.priority),
      el("span", { class: "card-id" }, issue.id),
    ),
    el("h3", { class: "card-title" }, issue.title),
    progress && progressBar(progress),
    labels.length > 0 &&
      el(
        "div",
        { class: "card-labels" },
        labels.slice(0, 3).map((label) => el("span", { class: "label" }, label)),
        labels.length > 3 &&
          el("span", { class: "label", title: labels.slice(3).join(", ") }, `+${labels.length - 3}`),
      ),
    el(
      "div",
      { class: "card-meta" },
      issue.assignee &&
        el(
          "span",
          { class: "assignee", title: issue.assignee },
          el("span", { class: "avatar", "aria-hidden": "true" }, initials(issue.assignee)),
          el("span", { class: "assignee-name" }, issue.assignee),
        ),
      el(
        "span",
        { class: "badges" },
        blockers.length > 0 &&
          el(
            "span",
            { class: "badge badge-blocked", title: `Blocked by ${blockers.join(", ")}` },
            icon("block"),
            blockers.length,
          ),
        leaseExpired(issue, ctx.now) &&
          el(
            "span",
            {
              class: "badge badge-warn",
              title: `The worker's lease expired ${dateTime(issue.lease_expires_at)}`,
            },
            icon("clock"),
            "stale",
          ),
        comments > 0 &&
          el(
            "span",
            { class: "badge", title: `${comments} comment${comments === 1 ? "" : "s"}` },
            icon("comment"),
            comments,
          ),
        el("span", { class: "when", title: when.title }, when.text),
      ),
    ),
  );
}

function cardTime(issue: Issue, columnId: ColumnId, now: Date): { text: string; title: string } {
  const pick = (verb: string, iso: string) => ({
    text: `${verb} ${relativeTime(iso, now)}`,
    title: `${verb[0].toUpperCase()}${verb.slice(1)} ${dateTime(iso)}`,
  });
  if (columnId === "done" && issue.closed_at) return pick("closed", issue.closed_at);
  if (columnId === "active" && issue.started_at) return pick("started", issue.started_at);
  if (columnId === "hold" && issue.defer_until) return pick("until", issue.defer_until);
  return pick("updated", issue.updated_at);
}

export function typeChip(type: string): HTMLElement {
  return el("span", { class: cls("type", `type-${token(type)}`) }, type);
}

export function priorityChip(priority: number): HTMLElement {
  return el(
    "span",
    { class: cls("prio", `prio-${priority}`), title: `Priority ${priority} (0 is highest)` },
    `P${priority}`,
  );
}

export function statusChip(status: string, category: StatusCategory | undefined): HTMLElement {
  return el(
    "span",
    { class: cls("status", `status-${token(category ?? "active")}`) },
    status.replace(/_/g, " "),
  );
}

export function progressBar({ done, total }: Progress): HTMLElement {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return el(
    "div",
    { class: "progress", title: `${done} of ${total} children closed` },
    el(
      "div",
      {
        class: "progress-track",
        role: "progressbar",
        "aria-valuemin": 0,
        "aria-valuemax": total,
        "aria-valuenow": done,
        "aria-label": "Children closed",
      },
      el("div", { class: "progress-fill", style: `width: ${percent}%` }),
    ),
    el("span", { class: "progress-text" }, `${done}/${total}`),
  );
}
