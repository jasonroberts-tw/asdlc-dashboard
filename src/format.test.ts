import { describe, expect, it } from "vitest";
import type { Issue } from "./beads";
import { humanize, initials, leaseExpired, relativeTime } from "./format";

const now = new Date("2026-09-28T12:00:00Z");

describe("relativeTime", () => {
  it("describes past and future times", () => {
    expect(relativeTime("2026-09-28T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-09-28T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-09-28T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-26T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("2026-10-01T12:00:00Z", now)).toBe("in 3d");
  });

  it("falls back to a date for distant times, with the year when it differs", () => {
    expect(relativeTime("2026-06-01T12:00:00Z", now)).not.toMatch(/ago|2026/);
    expect(relativeTime("2025-06-01T12:00:00Z", now)).toMatch(/2025/);
  });

  it("returns nothing for missing or invalid times", () => {
    expect(relativeTime(undefined, now)).toBe("");
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("initials", () => {
  it("takes the first and last word, or the first two letters", () => {
    expect(initials("Jason Roberts")).toBe("JR");
    expect(initials("Ada King Lovelace")).toBe("AL");
    expect(initials("claude")).toBe("CL");
    expect(initials("jason@jasonroberts.io")).toBe("JI");
  });
});

describe("leaseExpired", () => {
  const base = { id: "a", title: "", status: "in_progress", priority: 2, issue_type: "task" };
  const withLease = (lease?: string) =>
    ({ ...base, created_at: "", updated_at: "", lease_expires_at: lease }) as Issue;

  it("is true only once the lease time has passed", () => {
    expect(leaseExpired(withLease("2026-09-28T11:00:00Z"), now)).toBe(true);
    expect(leaseExpired(withLease("2026-09-28T13:00:00Z"), now)).toBe(false);
    expect(leaseExpired(withLease(undefined), now)).toBe(false);
  });
});

describe("humanize", () => {
  it("turns identifiers into words", () => {
    expect(humanize("discovered-from")).toBe("Discovered from");
    expect(humanize("in_progress")).toBe("In progress");
  });
});
