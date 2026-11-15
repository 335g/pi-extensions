// ── Event types for the commit pipeline ──────────────────

export type PipelineEvent =
  | { type: "info"; message: string }
  | { type: "error"; message: string }
  | { type: "committed"; message: string }
  | { type: "organised"; checkpointCount: number; commitCount: number }
  | { type: "fallback"; message: string }
  | { type: "merged"; message: string }
  | { type: "stage-changed"; hasChanges?: boolean };

export interface PipelineResult {
  events: PipelineEvent[];
  /** true when the commit was actually executed */
  committed: boolean;
}

export interface OrganizerResult {
  events: PipelineEvent[];
  organised: boolean;
}
