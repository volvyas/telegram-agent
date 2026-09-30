import type { AgentState } from "../agent/AgentState.js";
import type { AgentQuestionEvent, AgentTerminalEvent } from "../agent/AgentEvent.js";
import type { GitTaskSnapshot } from "./GitSnapshot.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "stopped";

export interface TaskTestSummary {
  readonly status: "not_run" | "passed" | "failed" | "stopped";
  readonly durationMs?: number;
  readonly exitCode?: number | null;
}

export interface TaskGitSummary {
  readonly branchBefore: string | null;
  readonly branchAfter: string | null;
  readonly cleanBefore: boolean;
  readonly cleanAfter: boolean;
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
  readonly observedDuringTaskFiles: number;
}

/** Complete runtime result for one finite agent turn. The full prompt is never retained. */
export interface TaskRecord {
  readonly id: string;
  readonly projectId: string;
  readonly promptSummary: string;
  readonly runId: string;
  readonly state: AgentState;
  readonly status: TaskStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly testSummary: TaskTestSummary;
  readonly gitSummary: TaskGitSummary;
  readonly terminalEvent: AgentTerminalEvent | AgentQuestionEvent;
  readonly git: GitTaskSnapshot;
}
