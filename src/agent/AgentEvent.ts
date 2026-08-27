export type AgentRunId = string;
export type AgentThreadId = string;

export interface AgentEventBase {
  readonly runId: AgentRunId;
  readonly projectId: string;
  readonly occurredAt: string;
}

export type AgentEvent =
  | AgentThreadStartedEvent
  | AgentRunStartedEvent
  | AgentProgressEvent
  | AgentCommandEvent
  | AgentFilesChangedEvent
  | AgentQuestionEvent
  | AgentWarningEvent
  | AgentErrorEvent
  | AgentCompletedEvent
  | AgentStoppedEvent;

export interface AgentThreadStartedEvent extends AgentEventBase {
  readonly type: "thread_started";
  readonly threadId: AgentThreadId;
}

export interface AgentRunStartedEvent extends AgentEventBase {
  readonly type: "run_started";
}

export interface AgentProgressEvent extends AgentEventBase {
  readonly type: "progress";
  readonly message: string;
  readonly stage?: string;
}

export interface AgentCommandEvent extends AgentEventBase {
  readonly type: "command";
  readonly command: string;
  readonly status: "running" | "completed" | "failed";
  readonly exitCode?: number;
}

export interface AgentFilesChangedEvent extends AgentEventBase {
  readonly type: "files_changed";
  readonly paths: readonly string[];
}

export interface AgentQuestionEvent extends AgentEventBase {
  readonly type: "question";
  readonly questionId: string;
  readonly question: string;
  readonly choices: readonly string[];
}

export interface AgentWarningEvent extends AgentEventBase {
  readonly type: "warning";
  readonly message: string;
}

export interface AgentErrorEvent extends AgentEventBase {
  readonly type: "error";
  readonly message: string;
  readonly fatal: boolean;
}

export interface AgentCompletedEvent extends AgentEventBase {
  readonly type: "completed";
  readonly summary: string;
  readonly details?: string;
}

export interface AgentStoppedEvent extends AgentEventBase {
  readonly type: "stopped";
  readonly reason: "user" | "shutdown" | "timeout";
}

export type AgentTerminalEvent =
  | AgentCompletedEvent
  | (AgentErrorEvent & { readonly fatal: true })
  | AgentStoppedEvent;
