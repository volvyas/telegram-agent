import type { ActorContext } from "../domain/Actor.js";
import type { AgentEvent } from "../agent/AgentEvent.js";
import type { AgentStatus } from "../agent/AgentManager.js";
import type { ProjectConfig } from "../config/ProjectConfig.js";
import type { PersistedTaskRecord } from "../storage/Storage.js";

/** Transport-neutral application contract. Adapters supply authenticated context. */
export interface ApplicationUseCases {
  readonly projects: {
    list(actor: ActorContext): Promise<readonly ProjectConfig[]>;
    select(actor: ActorContext, projectId: string): Promise<ProjectConfig>;
  };
  readonly agent: {
    status(actor: ActorContext, projectId: string): Promise<AgentStatus>;
    startTask(actor: ActorContext, projectId: string, prompt: string): Promise<PersistedTaskRecord>;
    answer(actor: ActorContext, projectId: string, questionId: string, answer: string): Promise<PersistedTaskRecord>;
    stop(actor: ActorContext, projectId: string): Promise<boolean>;
    events(actor: ActorContext, projectId: string): AsyncIterable<AgentEvent>;
  };
  readonly git: {
    status(actor: ActorContext, projectId: string): Promise<unknown>;
    diff(actor: ActorContext, projectId: string): Promise<unknown>;
    log(actor: ActorContext, projectId: string): Promise<unknown>;
  };
  readonly test: { run(actor: ActorContext, projectId: string): Promise<unknown> };
  readonly confirmations: {
    request(actor: ActorContext, projectId: string, operation: string): Promise<unknown>;
    consume(actor: ActorContext, id: string, projectId: string, decision: "allow" | "deny"): Promise<unknown>;
  };
}
