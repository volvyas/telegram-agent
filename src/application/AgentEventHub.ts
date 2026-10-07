import type { ActorId } from "../domain/Actor.js";
import type { AgentEvent } from "../agent/AgentEvent.js";

export interface AgentEventSubscription {
  readonly actorId: ActorId;
  readonly projectId?: string;
  readonly onEvent: (event: AgentEvent) => void;
}

/** Bounded, process-local fan-out. Subscribers only receive their actor/project events. */
export class AgentEventHub {
  readonly #maxSubscribers: number;
  readonly #subscriptions = new Set<AgentEventSubscription>();

  public constructor(maxSubscribers = 64) {
    if (!Number.isSafeInteger(maxSubscribers) || maxSubscribers < 1) throw new RangeError("Invalid subscriber limit");
    this.#maxSubscribers = maxSubscribers;
  }

  public subscribe(subscription: AgentEventSubscription): () => void {
    if (this.#subscriptions.size >= this.#maxSubscribers) throw new Error("Event subscriber limit reached");
    this.#subscriptions.add(subscription);
    return () => this.#subscriptions.delete(subscription);
  }

  public publish(event: AgentEvent): void {
    for (const subscription of this.#subscriptions) {
      if (event.ownerActorId !== subscription.actorId) continue;
      if (subscription.projectId !== undefined && subscription.projectId !== event.projectId) continue;
      subscription.onEvent(event);
    }
  }

  public get size(): number { return this.#subscriptions.size; }
}
