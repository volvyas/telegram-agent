export const AGENT_STATES = [
  "IDLE",
  "RUNNING",
  "WAITING_FOR_USER",
  "COMPLETED",
  "FAILED",
  "STOPPED",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export const AGENT_TRANSITION_REASONS = [
  "task_started",
  "agent_question",
  "user_answered",
  "turn_completed",
  "turn_failed",
  "stop_requested",
  "continued",
] as const;

export type AgentTransitionReason = (typeof AGENT_TRANSITION_REASONS)[number];

export interface AgentStateTransition {
  readonly from: AgentState;
  readonly to: AgentState;
  readonly reason: AgentTransitionReason;
  readonly occurredAt: string;
}

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === "string" && (AGENT_STATES as readonly string[]).includes(value);
}
