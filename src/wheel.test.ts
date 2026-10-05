import { describe, expect, it } from "vitest";
import { sidewaysDelta } from "./wheel";

const wheel = (deltaY: number, more: Partial<Parameters<typeof sidewaysDelta>[0]> = {}) => ({
  deltaX: 0,
  deltaY,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...more,
});

describe("sidewaysDelta", () => {
  it("moves sideways as far as the wheel turned, in either direction", () => {
    expect(sidewaysDelta(wheel(100), 800)).toBe(100);
    expect(sidewaysDelta(wheel(-40), 800)).toBe(-40);
  });

  it("converts lines and pages to pixels", () => {
    expect(sidewaysDelta(wheel(3, { deltaMode: 1 }), 800)).toBe(120);
    expect(sidewaysDelta(wheel(1, { deltaMode: 2 }), 800)).toBe(800);
  });

  it("follows a mostly up-and-down trackpad swipe", () => {
    expect(sidewaysDelta(wheel(30, { deltaX: 2 }), 800)).toBe(30);
  });

  it("leaves sideways turns, and no turn at all, to the webview", () => {
    expect(sidewaysDelta(wheel(0, { deltaX: 50 }), 800)).toBe(0);
    expect(sidewaysDelta(wheel(10, { deltaX: 30 }), 800)).toBe(0);
    expect(sidewaysDelta(wheel(0), 800)).toBe(0);
  });

  it("leaves Shift-, Ctrl- and ⌘-wheel alone", () => {
    expect(sidewaysDelta(wheel(100, { shiftKey: true }), 800)).toBe(0);
    expect(sidewaysDelta(wheel(100, { ctrlKey: true }), 800)).toBe(0);
    expect(sidewaysDelta(wheel(100, { metaKey: true }), 800)).toBe(0);
  });
});
