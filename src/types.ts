// Wspólne typy domenowe.

/** Typy obserwacji zgodne z claude-mem (tryb code) + nasze rozszerzenia. */
export const OBS_TYPES = [
  "bugfix",
  "feature",
  "refactor",
  "change",
  "discovery",
  "decision",
  "gotcha",
  "preference",
  "summary",
] as const;
export type ObsType = (typeof OBS_TYPES)[number] | (string & {});

export type Tier = "episodic" | "semantic" | "pinned";
export type ObsStatus = "active" | "merged" | "superseded" | "archived";
export type ObsSource = "digest" | "agent" | "claude-mem" | "consolidation" | "llm" | "backfill" | "automemory";

export interface TranscriptRef {
  path: string;
  from: number;
  to: number;
}

export interface Observation {
  id: number;
  session_id: string | null;
  project: string;
  prompt_n: number | null;
  type: ObsType;
  tier: Tier;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  text: string | null;
  created_at: number;
  updated_at: number;
  importance: number;
  source: ObsSource;
  content_hash: string | null;
  turn_key: string | null;
  status: ObsStatus;
  merged_into: number | null;
  superseded_by: number | null;
  valid_until: number | null;
  occurrence_count: number;
  access_count: number;
  last_access_at: number | null;
  inject_count: number;
  tokens: number;
  git_head: string | null;
  fingerprints: Record<string, string> | null;
  transcript_ref: TranscriptRef | null;
  meta: Record<string, unknown> | null;
}

export interface NewObservation {
  id?: number;
  session_id: string | null;
  project: string;
  prompt_n?: number | null;
  type: ObsType;
  tier?: Tier;
  title: string;
  subtitle?: string | null;
  narrative?: string | null;
  facts?: string[];
  concepts?: string[];
  files_read?: string[];
  files_modified?: string[];
  text?: string | null;
  created_at: number;
  importance?: number;
  source: ObsSource;
  content_hash?: string | null;
  turn_key?: string | null;
  status?: ObsStatus;
  occurrence_count?: number;
  access_count?: number;
  last_access_at?: number | null;
  git_head?: string | null;
  fingerprints?: Record<string, string> | null;
  transcript_ref?: TranscriptRef | null;
  meta?: Record<string, unknown> | null;
}

export interface Session {
  id: string;
  project: string;
  cwd: string | null;
  git_branch: string | null;
  title: string | null;
  first_prompt: string | null;
  started_at: number;
  ended_at: number | null;
  last_activity_at: number | null;
  prompt_count: number;
  transcript_path: string | null;
  transcript_offset: number;
  source: string;
  model: string | null;
  status: string;
  /** JSON: numer ostatniej tury (n), kotwica offsetu (anchor), katalog startowy sesji (root) i czy jest projektem (rootProject). */
  meta?: string | null;
}

export interface Summary {
  id: number;
  session_id: string | null;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  files_read: string[];
  files_edited: string[];
  prompt_n: number | null;
  created_at: number;
  source: string;
}

export interface EntityRef {
  kind: "file" | "dir" | "concept" | "command" | "url" | "tool" | "symbol";
  key: string;
  role: "read" | "modified" | "concept" | "mentioned";
}

export interface ContextBlock {
  text: string;
  tokens: number;
  obsIds: number[];
}
