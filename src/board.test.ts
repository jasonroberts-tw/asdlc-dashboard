import { describe, expect, it } from "vitest";
import type { BoardData, Issue, StatusCategory } from "./beads";
import {
  buildColumns,
  childProgress,
  columnFor,
  DEFAULT_FILTERS,
  descendantsOf,
  filterOptions,
  UNASSIGNED,
  visibleColumns,
  type ColumnId,
} from "./board";

const categories: Record<string, StatusCategory> = {
  open: "active",
  in_progress: "wip",
  blocked: "wip",
  hooked: "wip",
  review: "wip",
  closed: "done",
  deferred: "frozen",
  pinned: "frozen",
};

const now = new Date("2026-09-28T12:00:00Z");

function issue(id: string, fields: Partial<Issue> = {}): Issue {
  return {
    id,
    title: `Title of ${id}`,
    status: "open",
    priority: 2,
    issue_type: "task",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...fields,
  };
}

function columnIds(data: BoardData, filters = DEFAULT_FILTERS): Record<ColumnId, string[]> {
  const columns = buildColumns(data, categories, filters, now);
  return Object.fromEntries(
    columns.map((column) => [column.id, column.issues.map((i) => i.id)]),
  ) as Record<ColumnId, string[]>;
}

describe("columnFor", () => {
  const none = {};

  it("puts open issues with open blockers in Blocked, the rest in Ready", () => {
    expect(columnFor(issue("a"), categories, { a: ["b"] })).toBe("blocked");
    expect(columnFor(issue("a"), categories, { a: [] })).toBe("ready");
    expect(columnFor(issue("a"), categories, none)).toBe("ready");
  });

  it("puts the blocked status in Blocked even though its category is wip", () => {
    expect(columnFor(issue("a", { status: "blocked" }), categories, none)).toBe("blocked");
  });

  it("maps statuses by category, custom ones included", () => {
    expect(columnFor(issue("a", { status: "in_progress" }), categories, none)).toBe("active");
    expect(columnFor(issue("a", { status: "hooked" }), categories, none)).toBe("active");
    expect(columnFor(issue("a", { status: "review" }), categories, none)).toBe("active");
    expect(columnFor(issue("a", { status: "closed" }), categories, none)).toBe("done");
    expect(columnFor(issue("a", { status: "deferred" }), categories, none)).toBe("hold");
    expect(columnFor(issue("a", { status: "pinned" }), categories, none)).toBe("hold");
  });

  it("keeps in-progress work in progress when something blocks it", () => {
    expect(columnFor(issue("a", { status: "in_progress" }), categories, { a: ["b"] })).toBe(
      "active",
    );
  });

  it("treats a status with no known category as open", () => {
    expect(columnFor(issue("a", { status: "mystery" }), categories, none)).toBe("ready");
  });
});

describe("buildColumns", () => {
  it("returns every column in board order, even when empty", () => {
    const columns = buildColumns({ issues: [], blocked_by: {} }, categories, DEFAULT_FILTERS, now);
    expect(columns.map((c) => c.id)).toEqual(["hold", "blocked", "ready", "active", "done"]);
  });

  it("sorts open work by priority, then most recently updated", () => {
    const data: BoardData = {
      issues: [
        issue("low", { priority: 3, updated_at: "2026-09-27T00:00:00Z" }),
        issue("old", { priority: 1, updated_at: "2026-09-01T00:00:00Z" }),
        issue("new", { priority: 1, updated_at: "2026-09-20T00:00:00Z" }),
      ],
      blocked_by: {},
    };
    expect(columnIds(data).ready).toEqual(["new", "old", "low"]);
  });

  it("shows closed issues newest first, hiding those outside the done window", () => {
    const data: BoardData = {
      issues: [
        issue("week-old", { status: "closed", closed_at: "2026-09-22T12:00:00Z" }),
        issue("today", { status: "closed", closed_at: "2026-09-28T09:00:00Z" }),
        issue("ancient", { status: "closed", closed_at: "2026-06-01T00:00:00Z" }),
      ],
      blocked_by: {},
    };
    const columns = buildColumns(data, categories, DEFAULT_FILTERS, now);
    const done = columns.find((c) => c.id === "done")!;
    expect(done.issues.map((i) => i.id)).toEqual(["today", "week-old"]);
    expect(done.hidden).toBe(1);

    const all = buildColumns(data, categories, { ...DEFAULT_FILTERS, doneDays: 0 }, now);
    expect(all.find((c) => c.id === "done")!.issues).toHaveLength(3);
  });

  it("matches every search term against id, title, labels and assignee", () => {
    const data: BoardData = {
      issues: [
        issue("x-1", { title: "Fix login redirect", labels: ["auth"] }),
        issue("x-2", { title: "Login page copy", assignee: "Ada Lovelace" }),
        issue("x-3", { title: "Unrelated" }),
      ],
      blocked_by: {},
    };
    const search = (text: string) => columnIds(data, { ...DEFAULT_FILTERS, text }).ready.sort();
    expect(search("login")).toEqual(["x-1", "x-2"]);
    expect(search("LOGIN auth")).toEqual(["x-1"]);
    expect(search("ada")).toEqual(["x-2"]);
    expect(search("x-3")).toEqual(["x-3"]);
  });

  it("filters by type, priority, assignee and label", () => {
    const data: BoardData = {
      issues: [
        issue("bug", { issue_type: "bug", priority: 0, assignee: "Ada", labels: ["ui", "auth"] }),
        issue("task", { priority: 2 }),
      ],
      blocked_by: {},
    };
    expect(columnIds(data, { ...DEFAULT_FILTERS, type: "bug" }).ready).toEqual(["bug"]);
    expect(columnIds(data, { ...DEFAULT_FILTERS, priority: "2" }).ready).toEqual(["task"]);
    expect(columnIds(data, { ...DEFAULT_FILTERS, assignee: "Ada" }).ready).toEqual(["bug"]);
    expect(columnIds(data, { ...DEFAULT_FILTERS, assignee: UNASSIGNED }).ready).toEqual(["task"]);
    expect(columnIds(data, { ...DEFAULT_FILTERS, label: "auth" }).ready).toEqual(["bug"]);
    expect(columnIds(data, { ...DEFAULT_FILTERS, label: "au" }).ready).toEqual([]);
  });

  it("limits the board to an epic and everything under it", () => {
    const data: BoardData = {
      issues: [
        issue("epic", { issue_type: "epic" }),
        issue("child", { parent: "epic" }),
        issue("grandchild", { parent: "child" }),
        issue("other"),
      ],
      blocked_by: {},
    };
    expect(columnIds(data, { ...DEFAULT_FILTERS, epic: "epic" }).ready.sort()).toEqual([
      "child",
      "epic",
      "grandchild",
    ]);
  });
});

describe("visibleColumns", () => {
  const data: BoardData = {
    issues: [
      issue("open"),
      issue("ancient", { status: "closed", closed_at: "2026-06-01T00:00:00Z" }),
    ],
    blocked_by: {},
  };
  const ids = (filters = DEFAULT_FILTERS) =>
    visibleColumns(buildColumns(data, categories, filters, now)).map((c) => c.id);

  it("hides columns with no cards, Done included when its window leaves every issue out", () => {
    expect(ids()).toEqual(["ready"]);
    expect(ids({ ...DEFAULT_FILTERS, doneDays: 0 })).toEqual(["ready", "done"]);
  });

  it("keeps every column when none has a card", () => {
    expect(ids({ ...DEFAULT_FILTERS, text: "no such issue" })).toEqual([
      "hold",
      "blocked",
      "ready",
      "active",
      "done",
    ]);
  });
});

describe("descendantsOf", () => {
  it("survives a parent cycle", () => {
    const issues = [issue("a", { parent: "b" }), issue("b", { parent: "a" })];
    expect([...descendantsOf("a", issues)].sort()).toEqual(["a", "b"]);
  });
});

describe("childProgress", () => {
  it("counts closed and total direct children per parent", () => {
    const issues = [
      issue("epic"),
      issue("a", { parent: "epic", status: "closed" }),
      issue("b", { parent: "epic" }),
      issue("c", { parent: "a", status: "closed" }),
    ];
    const progress = childProgress(issues, categories);
    expect(progress.get("epic")).toEqual({ done: 1, total: 2 });
    expect(progress.get("a")).toEqual({ done: 1, total: 1 });
    expect(progress.has("b")).toBe(false);
  });
});

describe("filterOptions", () => {
  it("lists types, assignees, open issues' labels, and open epics and features", () => {
    const options = filterOptions(
      [
        issue("e-closed", { issue_type: "epic", status: "closed", priority: 0, labels: ["old"] }),
        issue("e-low", { issue_type: "epic", priority: 3 }),
        issue("e-high", { issue_type: "epic", priority: 1 }),
        issue("f-closed", { issue_type: "feature", status: "closed", priority: 0 }),
        issue("f-deferred", { issue_type: "feature", status: "deferred", priority: 2 }),
        issue("f-active", { issue_type: "feature", status: "in_progress", priority: 1 }),
        issue("t", { assignee: "Zed", labels: ["ui", "Backend"] }),
        issue("u", { issue_type: "bug", assignee: "Ada", labels: ["ui"] }),
      ],
      categories,
    );
    expect(options.types).toEqual(["bug", "epic", "feature", "task"]);
    expect(options.assignees).toEqual(["Ada", "Zed"]);
    expect(options.labels).toEqual(["Backend", "ui"]);
    expect(options.epics.map((e) => e.id)).toEqual(["e-high", "e-low"]);
    expect(options.features.map((f) => f.id)).toEqual(["f-active", "f-deferred"]);
  });
});
