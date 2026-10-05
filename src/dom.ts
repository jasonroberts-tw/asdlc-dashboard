type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;

/** Creates an element. Attributes that are null, undefined or false are left off. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  return fill(document.createElement(tag), attrs, children);
}

/** Creates an SVG element, as `el` creates an HTML one. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): SVGElementTagNameMap[K] {
  return fill(document.createElementNS("http://www.w3.org/2000/svg", tag), attrs, children);
}

function fill<T extends Element>(node: T, attrs: Attrs, children: (Child | Child[])[]): T {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "number" ? String(child) : child);
  }
  return node;
}

/** Joins the truthy class names. */
export function cls(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** A value that is safe to use as part of a class name. */
export function token(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

const ICONS = {
  block: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM4.1 11.9l7.8-7.8",
  clock: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM8 5v3.2l2 1.3",
  close: "M4 4l8 8M12 4l-8 8",
  comment: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z",
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
  folder: "M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H7.5L6 3.5H2.5a1 1 0 0 0-1 1z",
  graph: "M1.5 6.5h3v3h-3zM11.5 2.5h3v3h-3zM11.5 10.5h3v3h-3zM4.5 8H8M8 4v8M8 4h3.5M8 12h3.5",
  "new-window": "M2.5 2.5h11v11h-11zM2.5 5.5h11M8 7.5v4M6 9.5h4",
  refresh: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9zM10.3 10.3l3.2 3.2",
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  return svgEl(
    "svg",
    { viewBox: "0 0 16 16", class: "icon", "aria-hidden": "true" },
    svgEl("path", { d: ICONS[name] }),
  );
}
