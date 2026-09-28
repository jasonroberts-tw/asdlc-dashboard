import { invoke } from "@tauri-apps/api/core";

/** How beads groups statuses: ready to start, being worked, finished, or parked. */
export type StatusCategory = "active" | "wip" | "done" | "frozen";

export interface Dependency {
  issue_id: string;
  depends_on_id: string;
  type: string;
}

/** An issue as `bd list --json` returns it. bd omits empty fields. */
export interface Issue {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  assignee?: string;
  owner?: string;
  labels?: string[];
  parent?: string;
  dependencies?: Dependency[];
  created_at: string;
  created_by?: string;
  updated_at: string;
  started_at?: string;
  closed_at?: string;
  close_reason?: string;
  defer_until?: string;
  lease_expires_at?: string;
  comment_count?: number;
}

/** A neighbouring issue as `bd show --brief-deps` embeds it. */
export interface RelatedIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  dependency_type: string;
}

export interface Comment {
  id: string;
  author: string;
  text: string;
  created_at: string;
}

/** An issue as `bd show --json` returns it, with its comments and dependents. */
export interface IssueDetail extends Omit<Issue, "dependencies"> {
  dependencies?: RelatedIssue[];
  dependents?: RelatedIssue[];
  comments?: Comment[];
}

export interface Workspace {
  beads_dir: string;
  prefix: string;
  status_categories: Record<string, StatusCategory>;
}

export interface BoardData {
  issues: Issue[];
  /** Issue ID to the IDs of the open issues blocking it. */
  blocked_by: Record<string, string[]>;
}

export const openWorkspace = (path: string) =>
  invoke<Workspace>("open_workspace", { path });

export const loadBoard = (path: string) =>
  invoke<BoardData>("load_board", { path });

export const loadIssue = (path: string, id: string) =>
  invoke<IssueDetail>("load_issue", { path, id });

/** Changes whenever bd writes to the workspace; null if bd has never written. */
export const changeMarker = (beadsDir: string) =>
  invoke<number | null>("change_marker", { beadsDir });
