import type { Issue } from "./beads";

const UNITS: [limitSeconds: number, unitSeconds: number, suffix: string][] = [
  [45 * 60, 60, "m"],
  [22 * 3600, 3600, "h"],
  [26 * 86400, 86400, "d"],
];

/** "5m ago", "in 3d", or a date once it is more than a few weeks away. */
export function relativeTime(iso: string | undefined, now: Date): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((now.getTime() - time) / 1000);
  const distance = Math.abs(seconds);
  if (distance < 45) return "just now";
  for (const [limit, unit, suffix] of UNITS) {
    if (distance < limit) {
      const amount = `${Math.max(1, Math.round(distance / unit))}${suffix}`;
      return seconds >= 0 ? `${amount} ago` : `in ${amount}`;
    }
  }
  const date = new Date(time);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export function dateTime(iso: string | undefined): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Date(time).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function initials(name: string): string {
  const words = name.split(/[\s._@-]+/).filter(Boolean);
  const letters =
    words.length > 1 ? words[0][0] + words[words.length - 1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

/** An agent's claim on an in-progress issue that it stopped renewing. */
export function leaseExpired(issue: Issue, now: Date): boolean {
  if (!issue.lease_expires_at) return false;
  const expires = Date.parse(issue.lease_expires_at);
  return !Number.isNaN(expires) && expires < now.getTime();
}

export function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
