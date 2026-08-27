import type { AgentEvent, AgentRunId } from "./AgentEvent.js";

export interface AgentRun {
  readonly runId: AgentRunId;
  readonly projectId: string;
  readonly events: AsyncIterable<AgentEvent>;
}
