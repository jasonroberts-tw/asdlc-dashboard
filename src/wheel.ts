/** `WheelEvent.deltaMode` values, named here since tests run without a DOM. */
const DELTA_LINE = 1;
const DELTA_PAGE = 2;
/** Pixels per line, for a wheel that counts lines, as Chromium scrolls them. */
const LINE_HEIGHT = 40;

type Wheel = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey" | "ctrlKey" | "metaKey">;

/**
 * How far a mostly up-and-down wheel turn should move content sideways, in pixels; 0 for
 * a sideways turn, which already scrolls sideways (a trackpad swipe, or Shift-wheel on a
 * mouse), and for Ctrl- or ⌘-wheel, which zooms.
 */
export function sidewaysDelta(wheel: Wheel, pageWidth: number): number {
  if (wheel.shiftKey || wheel.ctrlKey || wheel.metaKey) return 0;
  if (Math.abs(wheel.deltaY) <= Math.abs(wheel.deltaX)) return 0;
  switch (wheel.deltaMode) {
    case DELTA_LINE:
      return wheel.deltaY * LINE_HEIGHT;
    case DELTA_PAGE:
      return wheel.deltaY * pageWidth;
    default:
      return wheel.deltaY;
  }
}

/**
 * Scrolls `scroller` sideways with the wheel wherever nothing under the pointer scrolls up
 * and down, so a mouse can move along a wide graph or across the board's columns. A column
 * or graph that scrolls up and down keeps the wheel; Shift-wheel moves it sideways.
 */
export function scrollSideways(event: WheelEvent, scroller: HTMLElement): void {
  const delta = sidewaysDelta(event, scroller.clientWidth);
  if (delta === 0 || scroller.scrollWidth <= scroller.clientWidth) return;
  for (let node = event.target as Element | null; node; node = node.parentElement) {
    if (scrollsVertically(node)) return;
    if (node === scroller) break;
  }
  event.preventDefault();
  scroller.scrollLeft += delta;
}

function scrollsVertically(element: Element): boolean {
  if (element.scrollHeight <= element.clientHeight) return false;
  const { overflowY } = getComputedStyle(element);
  return overflowY === "auto" || overflowY === "scroll";
}
