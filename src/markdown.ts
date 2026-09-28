import DOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({ gfm: true });

/** Finds issue IDs in text, so they can become links to the issue. */
export interface IssueRefs {
  pattern: RegExp;
  isKnown: (id: string) => boolean;
}

export type Segment = string | { id: string };

/**
 * Matches IDs with this workspace's prefix, such as `bomv2-la7` or `bomv2-la7.8`. The leading
 * group stands in for a lookbehind, which older WebKit versions reject.
 */
export function issueRefPattern(prefix: string): RegExp | null {
  if (!prefix) return null;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])(${escaped}-[a-z0-9]+(?:\\.[0-9]+)*)(?![\\w-])`, "g");
}

export function splitIssueRefs(text: string, refs: IssueRefs): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(refs.pattern)) {
    const id = match[2];
    if (!refs.isKnown(id)) continue;
    const start = match.index! + match[1].length;
    if (start > last) segments.push(text.slice(last, start));
    segments.push({ id });
    last = start + id.length;
  }
  if (last < text.length) segments.push(text.slice(last));
  return segments;
}

/** Renders untrusted markdown from the database as sanitized HTML. */
export function renderMarkdown(text: string, refs: IssueRefs | null): HTMLElement {
  const container = document.createElement("div");
  container.className = "markdown";
  container.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }));
  if (refs) linkIssueRefs(container, refs);
  return container;
}

function linkIssueRefs(root: HTMLElement, refs: IssueRefs): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest("a")) textNodes.push(node);
  }
  for (const node of textNodes) {
    const segments = splitIssueRefs(node.data, refs);
    if (!segments.some((segment) => typeof segment !== "string")) continue;
    node.replaceWith(
      ...segments.map((segment) => {
        if (typeof segment === "string") return segment;
        const link = document.createElement("a");
        link.href = "#";
        link.className = "issue-ref";
        link.dataset.issue = segment.id;
        link.textContent = segment.id;
        return link;
      }),
    );
  }
}
