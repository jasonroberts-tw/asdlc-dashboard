import type { Issue } from "./beads";

/**
 * Which links the graph follows from its root, as in `bd dep tree --direction`: what the root
 * depends on (its blockers, its parent, the issue it was discovered from, and so on), or what
 * depends on it (what it blocks, its children, what was discovered from it).
 */
export type GraphDirection = "dependencies" | "dependents";

/** A dependency, oriented the way the graph draws it: from `source`, nearer the root, to `target`. */
export interface GraphLink {
  source: string;
  target: string;
  /** The dependency type, such as `blocks` or `parent-child`. */
  type: string;
}

export interface Graph {
  rootId: string;
  /** Every issue reached from the root, the root first. */
  ids: string[];
  links: GraphLink[];
}

export function buildGraph(rootId: string, issues: Issue[], direction: GraphDirection): Graph {
  const priority = new Map(issues.map((issue) => [issue.id, issue.priority]));
  const outgoing = new Map<string, GraphLink[]>();
  for (const issue of issues) {
    for (const dep of issue.dependencies ?? []) {
      if (dep.issue_id === dep.depends_on_id) continue;
      const link =
        direction === "dependencies"
          ? { source: dep.issue_id, target: dep.depends_on_id, type: dep.type }
          : { source: dep.depends_on_id, target: dep.issue_id, type: dep.type };
      const links = outgoing.get(link.source) ?? [];
      links.push(link);
      outgoing.set(link.source, links);
    }
  }
  // IDs the list doesn't have, such as another workspace's, sort last.
  const rank = (id: string) => priority.get(id) ?? Infinity;
  const byTarget = (a: GraphLink, b: GraphLink) =>
    rank(a.target) - rank(b.target) || a.target.localeCompare(b.target);

  const ids = [rootId];
  const seen = new Set(ids);
  const links: GraphLink[] = [];
  const drawn = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    for (const link of [...(outgoing.get(ids[i]) ?? [])].sort(byTarget)) {
      // A link stored both ways, as `bd dep relate` stores it, is drawn once.
      const key = `${link.source}\n${link.target}\n${link.type}`;
      if (drawn.has(key) || drawn.has(`${link.target}\n${link.source}\n${link.type}`)) continue;
      drawn.add(key);
      links.push(link);
      if (!seen.has(link.target)) {
        seen.add(link.target);
        ids.push(link.target);
      }
    }
  }
  return { rootId, ids, links };
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutSizes {
  nodeWidth: number;
  nodeHeight: number;
  /** Horizontal space between columns, where the links run. */
  columnGap: number;
  /** Vertical space between boxes in a column. */
  rowGap: number;
  /** Space around the whole graph. */
  padding: number;
}

export interface PlacedNode {
  id: string;
  /** Distance from the root along the longest path, which is also the column. */
  column: number;
  /** Top-left corner. */
  x: number;
  y: number;
}

export interface PlacedLink extends GraphLink {
  /** From the source box's edge to the target box's edge; see `linkPath`. */
  points: Point[];
  /** Points back toward the root, closing a cycle. */
  back: boolean;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  links: PlacedLink[];
  width: number;
  height: number;
}

/** A box, or a bend point where a link passes through a column it skips. */
interface Slot {
  id: string | null;
  column: number;
  height: number;
  /** Position in the column. */
  order: number;
  /** Vertical center. */
  y: number;
  /** Linked slots in the previous and next columns. */
  before: Slot[];
  after: Slot[];
}

const ORDER_PASSES = 6;
/** The most space between the points where several links meet one side of a box. */
const PORT_SPACING = 10;

/**
 * Lays the graph out in columns, left to right from the root. Each issue sits one column
 * right of the farthest issue linking to it, so every link but those closing a cycle points
 * right. Links that skip columns bend through them, and the boxes in each column are ordered
 * to keep links from crossing.
 */
export function layoutGraph(graph: Graph, sizes: LayoutSizes): GraphLayout {
  const outgoing = new Map<string, number[]>();
  graph.links.forEach((link, i) => {
    const links = outgoing.get(link.source) ?? [];
    links.push(i);
    outgoing.set(link.source, links);
  });

  // A depth-first walk finds the links that close a cycle; the rest form a DAG.
  const back = new Set<number>();
  const visiting = new Set<string>();
  const finished = new Set<string>();
  const visit = (id: string) => {
    visiting.add(id);
    for (const i of outgoing.get(id) ?? []) {
      const target = graph.links[i].target;
      if (visiting.has(target)) back.add(i);
      else if (!finished.has(target)) visit(target);
    }
    visiting.delete(id);
    finished.add(id);
  };
  visit(graph.rootId);

  // Columns by longest path, taking issues in topological order (reverse finishing order).
  const column = new Map(graph.ids.map((id) => [id, 0]));
  for (const id of [...finished].reverse()) {
    for (const i of outgoing.get(id) ?? []) {
      if (back.has(i)) continue;
      const target = graph.links[i].target;
      column.set(target, Math.max(column.get(target)!, column.get(id)! + 1));
    }
  }

  const columns: Slot[][] = [];
  const add = (id: string | null, at: number): Slot => {
    const slots = (columns[at] ??= []);
    const slot: Slot = {
      id,
      column: at,
      height: id === null ? 0 : sizes.nodeHeight,
      order: slots.length,
      y: 0,
      before: [],
      after: [],
    };
    slots.push(slot);
    return slot;
  };
  const slots = new Map<string, Slot>();
  const slotFor = (id: string) => {
    let slot = slots.get(id);
    if (!slot) slots.set(id, (slot = add(id, column.get(id)!)));
    return slot;
  };
  slotFor(graph.rootId);
  const chains = new Map<number, Slot[]>();
  graph.links.forEach((link, i) => {
    if (back.has(i)) return;
    const source = slotFor(link.source);
    const chain = [source];
    for (let at = source.column + 1; at < column.get(link.target)!; at++) chain.push(add(null, at));
    chain.push(slotFor(link.target));
    for (let k = 1; k < chain.length; k++) {
      chain[k - 1].after.push(chain[k]);
      chain[k].before.push(chain[k - 1]);
    }
    chains.set(i, chain);
  });

  orderColumns(columns);
  const gap = (a: Slot, b: Slot) =>
    (a.height + b.height) / 2 + (a.id !== null && b.id !== null ? sizes.rowGap : sizes.rowGap / 2);
  // Each column follows the one before it, then each lines up with the one after it, so a box
  // ends up centered on the boxes it links to.
  for (const slots of columns.slice(1)) {
    place(slots, slots.map((slot) => mean(slot.before.map((s) => s.y)) ?? slot.y), gap);
  }
  for (const slots of columns.slice(0, -1).reverse()) {
    place(slots, slots.map((slot) => mean(slot.after.map((s) => s.y)) ?? slot.y), gap);
  }

  const all = columns.flat();
  const top = Math.min(...all.map((slot) => slot.y - slot.height / 2));
  for (const slot of all) slot.y += sizes.padding - top;
  const left = (at: number) => sizes.padding + at * (sizes.nodeWidth + sizes.columnGap);
  const height = Math.max(...all.map((slot) => slot.y + slot.height / 2)) + sizes.padding;
  const width = left(columns.length) - sizes.columnGap + sizes.padding;

  const ports = linkPorts(graph, chains, sizes.nodeHeight);
  const links = graph.links.map((link, i): PlacedLink => {
    const chain = chains.get(i);
    if (!chain) {
      const source = slots.get(link.source)!;
      const target = slots.get(link.target)!;
      return {
        ...link,
        back: true,
        points: [
          { x: left(source.column), y: source.y },
          { x: left(target.column) + sizes.nodeWidth, y: target.y },
        ],
      };
    }
    const [source, ...rest] = chain;
    const target = rest.pop()!;
    return {
      ...link,
      back: false,
      points: [
        { x: left(source.column) + sizes.nodeWidth, y: ports.get(i)!.from },
        ...rest.flatMap((bend) => [
          { x: left(bend.column), y: bend.y },
          { x: left(bend.column) + sizes.nodeWidth, y: bend.y },
        ]),
        { x: left(target.column), y: ports.get(i)!.to },
      ],
    };
  });

  return {
    nodes: graph.ids.map((id) => {
      const slot = slots.get(id)!;
      return { id, column: slot.column, x: left(slot.column), y: slot.y - slot.height / 2 };
    }),
    links,
    width,
    height,
  };
}

/**
 * The SVG path through a link's points: curves across the gaps between columns, and straight
 * lines through the columns a link skips.
 */
export function linkPath(points: Point[]): string {
  const [start, ...rest] = points;
  let path = `M${start.x} ${start.y}`;
  rest.forEach((point, i) => {
    const from = points[i];
    if (i % 2 === 1) {
      path += ` L${point.x} ${point.y}`;
    } else {
      const middle = (from.x + point.x) / 2;
      path += ` C${middle} ${from.y} ${middle} ${point.y} ${point.x} ${point.y}`;
    }
  });
  return path;
}

/**
 * Sorts each column by where its slots' links lead, sweeping right and then left, and keeps
 * the order with the fewest crossings.
 */
function orderColumns(columns: Slot[][]): void {
  let best = columns.map((slots) => [...slots]);
  let fewest = crossings(columns);
  for (let pass = 0; pass < ORDER_PASSES && fewest > 0; pass++) {
    const sweep = pass % 2 === 0 ? columns.slice(1) : columns.slice(0, -1).reverse();
    for (const slots of sweep) {
      const center = new Map(
        slots.map((slot) => {
          const linked = pass % 2 === 0 ? slot.before : slot.after;
          return [slot, mean(linked.map((s) => s.order)) ?? slot.order];
        }),
      );
      slots.sort((a, b) => center.get(a)! - center.get(b)!);
      slots.forEach((slot, i) => (slot.order = i));
    }
    const count = crossings(columns);
    if (count < fewest) {
      fewest = count;
      best = columns.map((slots) => [...slots]);
    }
  }
  best.forEach((slots, at) => {
    columns[at] = slots;
    slots.forEach((slot, i) => (slot.order = i));
  });
}

function crossings(columns: Slot[][]): number {
  let count = 0;
  for (const slots of columns) {
    const pairs = slots.flatMap((slot) => slot.after.map((next) => [slot.order, next.order]));
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        if ((pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1]) < 0) count++;
      }
    }
  }
  return count;
}

/**
 * Sets each slot's center as close to the wanted one as it can be (least squares) while
 * keeping the column's order and the gaps between slots. Taking each slot's minimum offset
 * from the first one away turns this into fitting a non-decreasing sequence, which pooling
 * adjacent violators solves exactly.
 */
function place(slots: Slot[], wanted: number[], gap: (a: Slot, b: Slot) => number): void {
  const offsets = [0];
  for (let i = 1; i < slots.length; i++) offsets.push(offsets[i - 1] + gap(slots[i - 1], slots[i]));
  const pools: { sum: number; count: number }[] = [];
  wanted.forEach((y, i) => {
    pools.push({ sum: y - offsets[i], count: 1 });
    while (pools.length > 1) {
      const last = pools[pools.length - 1];
      const before = pools[pools.length - 2];
      if (before.sum / before.count <= last.sum / last.count) break;
      before.sum += last.sum;
      before.count += last.count;
      pools.pop();
    }
  });
  let i = 0;
  for (const pool of pools) {
    for (let k = 0; k < pool.count; k++, i++) slots[i].y = pool.sum / pool.count + offsets[i];
  }
}

/**
 * Where each link leaves its source and reaches its target. Links meeting the same side of a
 * box are spread along it in the order of where they come from, so they don't cross there.
 */
function linkPorts(
  graph: Graph,
  chains: Map<number, Slot[]>,
  nodeHeight: number,
): Map<number, { from: number; to: number }> {
  const ports = new Map<number, { from: number; to: number }>();
  const sides = new Map<string, { link: number; toward: number }[]>();
  const meet = (side: string, link: number, toward: number) => {
    const links = sides.get(side) ?? [];
    links.push({ link, toward });
    sides.set(side, links);
  };
  for (const [i, chain] of chains) {
    ports.set(i, { from: chain[0].y, to: chain[chain.length - 1].y });
    meet(`out\n${graph.links[i].source}`, i, chain[1].y);
    meet(`in\n${graph.links[i].target}`, i, chain[chain.length - 2].y);
  }
  for (const [side, links] of sides) {
    if (links.length < 2) continue;
    const outgoing = side.startsWith("out");
    const spread = Math.min(nodeHeight - 16, (links.length - 1) * PORT_SPACING);
    links
      .sort((a, b) => a.toward - b.toward)
      .forEach(({ link }, k) => {
        const port = ports.get(link)!;
        const center = outgoing ? port.from : port.to;
        const y = center - spread / 2 + (spread * k) / (links.length - 1);
        if (outgoing) port.from = y;
        else port.to = y;
      });
  }
  return ports;
}

function mean(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}
