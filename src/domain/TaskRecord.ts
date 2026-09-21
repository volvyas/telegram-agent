import type { AgentState } from "../agent/AgentState.js";
import type { AgentQuestionEvent, AgentTerminalEvent } from "../agent/AgentEvent.js";
import type { GitTaskSnapshot } from "./GitSnapshot.js";

/** Runtime result for one finite agent turn. IDs/history are introduced in DEV-035. */
export interface TaskRecord {
  readonly projectId: string;
  readonly runId: string;
  readonly state: AgentState;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly terminalEvent: AgentTerminalEvent | AgentQuestionEvent;
  readonly git: GitTaskSnapshot;
}
