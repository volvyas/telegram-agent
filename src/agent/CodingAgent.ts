import type { AgentRun } from "./AgentRun.js";

export interface AgentStartOptions {
  readonly projectId: string;
  readonly workingDirectory: string;
  readonly prompt: string;
}

export interface AgentResumeOptions extends AgentStartOptions {
  readonly threadId: string;
}

export interface AgentMessageOptions {
  readonly projectId: string;
  readonly workingDirectory: string;
  readonly threadId: string;
  readonly message: string;
}

export interface CodingAgent {
  start(options: AgentStartOptions): Promise<AgentRun>;
  resume(options: AgentResumeOptions): Promise<AgentRun>;
  send(options: AgentMessageOptions): Promise<AgentRun>;
  stop(runId: string): Promise<boolean>;
}
