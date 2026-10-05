import type { Issue, StatusCategory } from "./beads";
import { cls, el, icon, svgEl, token } from "./dom";
import {
  buildGraph,
  layoutGraph,
  linkPath,
  type GraphDirection,
  type GraphLayout,
  type LayoutSizes,
  type PlacedLink,
  type PlacedNode,
} from "./graph";
import { priorityChip, typeChip } from "./render";

export interface GraphContext {
  issues: Issue[];
  issuesById: Map<string, Issue>;
  categories: Record<string, StatusCategory>;
  selectedId: string | null;
}

/** Matches the box styles in styles.css. */
const SIZES: LayoutSizes = {
  nodeWidth: 240,
  nodeHeight: 92,
  columnGap: 72,
  rowGap: 16,
  padding: 24,
};

const ARROW_LENGTH = 7;

const DIRECTIONS: [GraphDirection, string, string][] = [
  [
    "dependencies",
    "Dependencies",
    "What this issue depends on, and what those depend on: blockers, parent, the issue it was discovered from",
  ],
  [
    "dependents",
    "Dependents",
    "What depends on this issue, and what depends on those: the issues it blocks, its children, issues discovered from it",
  ],
];

/** The legend's order; other types follow alphabetically. */
const LINK_TYPES = [
  "blocks",
  "parent-child",
  "discovered-from",
  "caused-by",
  "related",
  "relates-to",
  "supersedes",
  "duplicates",
  "tracks",
  "until",
  "validates",
];

export function renderGraph(
  rootId: string,
  direction: GraphDirection,
  ctx: GraphContext,
): HTMLElement[] {
  const graph = buildGraph(rootId, ctx.issues, direction);
  const layout = layoutGraph(graph, SIZES);
  const linked = graph.ids.length - 1;
  const summary =
    linked > 0
      ? `${linked} linked issue${linked === 1 ? "" : "s"}`
      : direction === "dependencies"
        ? "Depends on no other issue"
        : "No issue depends on it";
  return [
    el(
      "header",
      { class: "graph-header" },
      el(
        "h2",
        { class: "graph-title" },
        "Dependency graph",
        el("span", { class: "graph-root-id" }, rootId),
      ),
      el(
        "div",
        { class: "segmented", role: "group", "aria-label": "Links to follow" },
        DIRECTIONS.map(([value, label, hint]) =>
          el(
            "button",
            {
              type: "button",
              "data-action": "graph-direction",
              "data-direction": value,
              "aria-pressed": String(value === direction),
              title: hint,
            },
            label,
          ),
        ),
      ),
      el("span", { class: "graph-summary" }, summary),
      el(
        "button",
        {
          type: "button",
          class: "icon-button graph-close",
          "data-action": "close-graph",
          "aria-label": "Close graph",
          title: "Close (Esc)",
        },
        icon("close"),
      ),
    ),
    el(
      "div",
      { class: "graph-scroll" },
      el(
        "div",
        { class: "graph-canvas", style: `width: ${layout.width}px; height: ${layout.height}px` },
        renderLinks(layout, direction),
        layout.nodes.map((node) => renderNode(node, rootId, ctx)),
      ),
    ),
    renderLegend(layout.links),
  ].filter((part): part is HTMLElement => part !== null);
}

function renderNode(node: PlacedNode, rootId: string, ctx: GraphContext): HTMLElement {
  const issue = ctx.issuesById.get(node.id);
  const category = issue ? ctx.categories[issue.status] : undefined;
  return el(
    "button",
    {
      type: "button",
      class: cls(
        "graph-node",
        node.id === rootId && "root",
        node.id === ctx.selectedId && "selected",
        category === "done" && "done",
        !issue && "unknown",
      ),
      "data-issue": node.id,
      "data-priority": issue?.priority,
      style: `left: ${node.x}px; top: ${node.y}px; width: ${SIZES.nodeWidth}px; height: ${SIZES.nodeHeight}px`,
      title: issue ? `${node.id}: ${issue.title}` : `${node.id} is not in this folder's issues`,
    },
    el(
      "span",
      { class: "graph-node-top" },
      issue && typeChip(issue.issue_type),
      issue && priorityChip(issue.priority),
      issue &&
        el(
          "span",
          { class: "graph-node-status" },
          el("span", {
            class: cls("status-dot", `status-${token(category ?? "unknown")}`),
            "aria-hidden": "true",
          }),
          issue.status.replace(/_/g, " "),
        ),
    ),
    el("span", { class: "graph-node-id" }, node.id),
    el("span", { class: "graph-node-title" }, issue?.title ?? "Not in this folder's issues"),
  );
}

function renderLinks(layout: GraphLayout, direction: GraphDirection): SVGSVGElement {
  return svgEl(
    "svg",
    { class: "graph-links", width: layout.width, height: layout.height },
    layout.links.map((link) => {
      const tip = link.points[link.points.length - 1];
      const from = link.points[link.points.length - 2];
      // Most links arrive heading right; one closing a cycle arrives heading left.
      const heading = tip.x < from.x ? -1 : 1;
      const base = tip.x - heading * ARROW_LENGTH;
      const path = linkPath([...link.points.slice(0, -1), { x: base, y: tip.y }]);
      return svgEl(
        "g",
        { class: cls("graph-link", `link-${token(link.type)}`, link.back && "back") },
        svgEl("title", {}, describeLink(link, direction)),
        svgEl("path", { class: "graph-link-hit", d: path }),
        svgEl("path", { class: "graph-link-line", d: path }),
        svgEl("path", {
          class: "graph-link-arrow",
          d: `M${tip.x} ${tip.y} L${base} ${tip.y - 4} L${base} ${tip.y + 4} Z`,
        }),
      );
    }),
  );
}

/** In `bd dep list` terms, whichever way the graph runs. */
function describeLink(link: PlacedLink, direction: GraphDirection): string {
  const [dependent, dependency] =
    direction === "dependencies" ? [link.source, link.target] : [link.target, link.source];
  return `${dependent} depends on ${dependency} via ${link.type}${link.back ? ", closing a cycle" : ""}`;
}

function renderLegend(links: PlacedLink[]): HTMLElement | null {
  if (links.length === 0) return null;
  const rank = (type: string) => {
    const index = LINK_TYPES.indexOf(type);
    return index === -1 ? LINK_TYPES.length : index;
  };
  const types = [...new Set(links.map((link) => link.type))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  );
  return el(
    "ul",
    { class: "graph-legend", "aria-label": "Link types" },
    types.map((type) =>
      el(
        "li",
        { class: `link-${token(type)}` },
        el("span", { class: "graph-swatch", "aria-hidden": "true" }),
        type,
      ),
    ),
  );
}
