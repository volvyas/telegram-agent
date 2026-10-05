import type { AgentEvent, AgentRunId, AgentThreadId } from "../agent/AgentEvent.js";
import type { AgentState } from "../agent/AgentState.js";
import type { AgentIdentity } from "./AgentIdentity.js";

/** A question that terminates a turn and must be answered before it can resume. */
export interface PendingAgentQuestion {
  readonly questionId: string;
  readonly question: string;
  readonly choices: readonly string[];
  readonly userId?: number;
  readonly createdAt: string;
}

/** Runtime view of one project's agent conversation. Transient fields are not persisted. */
export interface AgentSession {
  readonly projectId: string;
  readonly projectPath: string;
  readonly state: AgentState;
  readonly threadId?: AgentThreadId;
  readonly activeRunId?: AgentRunId;
  readonly lastEvent?: AgentEvent;
  readonly pendingQuestion?: PendingAgentQuestion;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly agentIdentity?: AgentIdentity;
  readonly resumable?: boolean;
  readonly historicalThreadId?: AgentThreadId;
  readonly resumeDiagnostic?: "AGENT_IDENTITY_CHANGED";
}
