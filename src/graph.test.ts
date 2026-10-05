import { describe, expect, it } from "vitest";
import type { Issue } from "./beads";
import { buildGraph, layoutGraph, linkPath, type Graph, type GraphLayout } from "./graph";

function issue(id: string, links: [dependsOn: string, type: string][] = [], priority = 2): Issue {
  return {
    id,
    title: `Title of ${id}`,
    status: "open",
    priority,
    issue_type: "task",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    dependencies: links.map(([dependsOn, type]) => ({
      issue_id: id,
      depends_on_id: dependsOn,
      type,
    })),
  };
}

const sizes = { nodeWidth: 200, nodeHeight: 80, columnGap: 60, rowGap: 20, padding: 10 };

function columnsOf(layout: GraphLayout): Record<string, number> {
  return Object.fromEntries(layout.nodes.map((node) => [node.id, node.column]));
}

describe("buildGraph", () => {
  // epic <- a (child), a depends on b, b was discovered from c; d depends on a.
  const issues = [
    issue("epic"),
    issue("a", [
      ["epic", "parent-child"],
      ["b", "blocks"],
    ]),
    issue("b", [["c", "discovered-from"]]),
    issue("c"),
    issue("d", [["a", "blocks"]]),
  ];

  it("follows every kind of link to what the root depends on, transitively", () => {
    const graph = buildGraph("a", issues, "dependencies");
    expect(graph.ids).toEqual(["a", "b", "epic", "c"]);
    expect(graph.links).toEqual([
      { source: "a", target: "b", type: "blocks" },
      { source: "a", target: "epic", type: "parent-child" },
      { source: "b", target: "c", type: "discovered-from" },
    ]);
  });

  it("follows links the other way for dependents, oriented away from the root", () => {
    const graph = buildGraph("epic", issues, "dependents");
    expect(graph.ids).toEqual(["epic", "a", "d"]);
    expect(graph.links).toEqual([
      { source: "epic", target: "a", type: "parent-child" },
      { source: "a", target: "d", type: "blocks" },
    ]);
  });

  it("visits higher-priority links first", () => {
    const graph = buildGraph(
      "root",
      [issue("root", [["low", "blocks"], ["high", "blocks"]]), issue("low", [], 3), issue("high", [], 0)],
      "dependencies",
    );
    expect(graph.ids).toEqual(["root", "high", "low"]);
  });

  it("draws a link stored both ways once", () => {
    const graph = buildGraph(
      "a",
      [issue("a", [["b", "relates-to"]]), issue("b", [["a", "relates-to"]])],
      "dependencies",
    );
    expect(graph.links).toEqual([{ source: "a", target: "b", type: "relates-to" }]);
  });

  it("keeps IDs the list doesn't have, such as external references", () => {
    const graph = buildGraph("a", [issue("a", [["external:other:cap", "blocks"]])], "dependencies");
    expect(graph.ids).toEqual(["a", "external:other:cap"]);
  });

  it("is just the root when nothing links its way", () => {
    expect(buildGraph("c", issues, "dependencies")).toEqual({ rootId: "c", ids: ["c"], links: [] });
    expect(buildGraph("missing", issues, "dependencies").ids).toEqual(["missing"]);
  });
});

describe("layoutGraph", () => {
  it("puts each issue one column right of the farthest issue linking to it", () => {
    // root -> a -> b, and root -> b directly: b goes after a, not beside it.
    const graph: Graph = {
      rootId: "root",
      ids: ["root", "a", "b"],
      links: [
        { source: "root", target: "a", type: "blocks" },
        { source: "root", target: "b", type: "blocks" },
        { source: "a", target: "b", type: "blocks" },
      ],
    };
    const layout = layoutGraph(graph, sizes);
    expect(columnsOf(layout)).toEqual({ root: 0, a: 1, b: 2 });
    const root = layout.nodes[0];
    expect(root).toMatchObject({ x: 10, y: expect.any(Number) });
    expect(layout.links.every((link) => !link.back)).toBe(true);
    // The link that skips a column bends through it: start, two bend points, end.
    const skipping = layout.links[1];
    expect(skipping.points).toHaveLength(4);
    expect(skipping.points[1].x).toBe(10 + 260);
    expect(skipping.points[2].x).toBe(10 + 260 + 200);
  });

  it("starts links at the source's right edge and ends them at the target's left edge", () => {
    const graph: Graph = {
      rootId: "root",
      ids: ["root", "a"],
      links: [{ source: "root", target: "a", type: "blocks" }],
    };
    const { nodes, links } = layoutGraph(graph, sizes);
    const [start, end] = links[0].points;
    expect(start).toEqual({ x: nodes[0].x + 200, y: nodes[0].y + 40 });
    expect(end).toEqual({ x: nodes[1].x, y: nodes[1].y + 40 });
  });

  it("keeps boxes in a column apart and centers a parent on its children", () => {
    const graph: Graph = {
      rootId: "root",
      ids: ["root", "a", "b", "c"],
      links: ["a", "b", "c"].map((target) => ({ source: "root", target, type: "parent-child" })),
    };
    const layout = layoutGraph(graph, sizes);
    const [root, ...children] = layout.nodes;
    const tops = children.map((node) => node.y).sort((x, y) => x - y);
    for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeGreaterThanOrEqual(100);
    expect(root.y).toBeCloseTo((tops[0] + tops[2]) / 2);
    expect(Math.min(...layout.nodes.map((node) => node.y))).toBe(10);
    expect(layout.height).toBe(tops[2] + 80 + 10);
    expect(layout.width).toBe(10 + 200 + 60 + 200 + 10);
  });

  it("spreads the links leaving one side of a box", () => {
    const graph: Graph = {
      rootId: "root",
      ids: ["root", "a", "b"],
      links: [
        { source: "root", target: "a", type: "blocks" },
        { source: "root", target: "b", type: "related" },
      ],
    };
    const [first, second] = layoutGraph(graph, sizes).links;
    expect(first.points[0].y).not.toBe(second.points[0].y);
  });

  it("orders a column to avoid crossing links", () => {
    // root -> x, y; x -> q; y -> p. Discovery puts p above q, which crosses until reordered.
    const graph: Graph = {
      rootId: "root",
      ids: ["root", "x", "y", "p", "q"],
      links: [
        { source: "root", target: "x", type: "blocks" },
        { source: "root", target: "y", type: "blocks" },
        { source: "y", target: "p", type: "blocks" },
        { source: "x", target: "q", type: "blocks" },
      ],
    };
    const nodes = new Map(layoutGraph(graph, sizes).nodes.map((node) => [node.id, node]));
    const above = (a: string, b: string) => nodes.get(a)!.y < nodes.get(b)!.y;
    expect(above("x", "y")).toBe(above("q", "p"));
  });

  it("marks a link that closes a cycle and draws it leftward", () => {
    const graph: Graph = {
      rootId: "a",
      ids: ["a", "b"],
      links: [
        { source: "a", target: "b", type: "blocks" },
        { source: "b", target: "a", type: "discovered-from" },
      ],
    };
    const layout = layoutGraph(graph, sizes);
    expect(columnsOf(layout)).toEqual({ a: 0, b: 1 });
    const cycle = layout.links[1];
    expect(cycle.back).toBe(true);
    expect(cycle.points[0].x).toBeGreaterThan(cycle.points[1].x);
  });

  it("lays out a lone root", () => {
    const layout = layoutGraph({ rootId: "a", ids: ["a"], links: [] }, sizes);
    expect(layout.nodes).toEqual([{ id: "a", column: 0, x: 10, y: 10 }]);
    expect(layout).toMatchObject({ width: 220, height: 100 });
  });
});

describe("linkPath", () => {
  it("curves between columns and runs straight through skipped ones", () => {
    expect(
      linkPath([
        { x: 0, y: 0 },
        { x: 20, y: 10 },
        { x: 40, y: 10 },
        { x: 60, y: 30 },
      ]),
    ).toBe("M0 0 C10 0 10 10 20 10 L40 10 C50 10 50 30 60 30");
  });
});
