import type { AgentEvent, AgentRunId, AgentThreadId } from "../agent/AgentEvent.js";
import type { AgentState } from "../agent/AgentState.js";

/** Runtime view of one project's agent conversation. Transient fields are not persisted. */
export interface AgentSession {
  readonly projectId: string;
  readonly projectPath: string;
  readonly state: AgentState;
  readonly threadId?: AgentThreadId;
  readonly activeRunId?: AgentRunId;
  readonly lastEvent?: AgentEvent;
  readonly startedAt?: string;
  readonly updatedAt: string;
}
