export type Action = "save" | "update" | "discard" | "defer";
export type Kind =
  | "knowledge"
  | "decision"
  | "experience"
  | "preference"
  | "task"
  | "hypothesis";
export interface Project {
  id: string;
  name: string;
  root: string;
  vault: string;
  writable_dirs: string[];
  excluded_dirs: string[];
  capture_enabled: boolean;
  min_samples: number;
  min_sessions: number;
  max_error: number;
  synthetic?: boolean;
  authorizations?: Array<{ kind: string; action: string; enabled: boolean }>;
}
export interface Proposal {
  id: string;
  project_id: string;
  session_id: string;
  status: string;
  revision: number;
  created_at: string;
  title: string;
  content: string;
  kind: Kind;
  source: string;
  tags: string[];
  links: string[];
  target: string;
  recommended_action: Action;
  rationale: string;
  base_hash?: string;
  before?: string;
  after?: string;
  risk_flags: string[];
  synthetic?: boolean;
  policy_prediction?: Partial<Review> & { evidence?: string; reason?: string };
}
export interface Review {
  revision: number;
  action: Action;
  reason: string;
  title?: string;
  content?: string;
  target?: string;
  links?: string[];
  tags?: string[];
  preview_token?: string;
}
export interface Preview {
  before: string;
  after: string;
  diff: string;
  target: string;
  preview_token: string;
}
export interface Write {
  id: string;
  project_id: string;
  proposal_id: string;
  status: string;
  created_at: string;
  target: string;
  before: string;
  after: string;
  [key: string]: unknown;
}
export interface Feedback {
  id: string;
  project_id: string;
  session_id: string;
  proposal_id: string;
  created_at: string;
  original: Record<string, unknown>;
  decision: Record<string, unknown>;
  actor: string;
  synthetic?: boolean;
}
export interface Policy {
  id: string;
  project_id: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
}
export interface Settings {
  enabled: boolean;
  provider?: "openai_compatible" | "codex_cli";
  endpoint: string;
  model: string;
  key_env: string;
  daily_calls: number;
  max_input_chars: number;
  max_tokens: number;
  learning_enabled: boolean;
}
export interface AppState {
  preferred_project_id?: string | null;
  projects: Project[];
  proposals: Proposal[];
  writes: Write[];
  policies: Policy[];
  feedback: Feedback[];
  events: Record<string, unknown>[];
  settings: Settings;
  stats: Record<string, number>;
  learning?: Record<
    string,
    { mode: string; human_samples: number; human_sessions?: number }
  >;
}
export interface Note {
  path: string;
  title: string;
  content: string;
  hash: string;
  links: string[];
}
export interface NotesData {
  notes: Note[];
  nodes: { id: string; label: string }[];
  edges: { source: string; target: string }[];
}
export type Run = (
  key: string,
  operation: () => Promise<unknown>,
  success?: string,
) => Promise<void>;
