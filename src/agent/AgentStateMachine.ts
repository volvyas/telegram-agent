import type {
  AgentState,
  AgentStateTransition,
  AgentTransitionReason,
} from "./AgentState.js";
import { AGENT_TRANSITION_REASONS, isAgentState } from "./AgentState.js";

type TransitionTable = Readonly<
  Record<AgentState, Readonly<Partial<Record<AgentTransitionReason, AgentState>>>>
>;

const TRANSITIONS: TransitionTable = Object.freeze({
  IDLE: Object.freeze({
    task_started: "RUNNING",
  }),
  RUNNING: Object.freeze({
    agent_question: "WAITING_FOR_USER",
    turn_completed: "COMPLETED",
    turn_failed: "FAILED",
    stop_requested: "STOPPED",
  }),
  WAITING_FOR_USER: Object.freeze({
    user_answered: "RUNNING",
    turn_failed: "FAILED",
    stop_requested: "STOPPED",
  }),
  COMPLETED: Object.freeze({
    continued: "RUNNING",
  }),
  FAILED: Object.freeze({
    continued: "RUNNING",
  }),
  STOPPED: Object.freeze({
    continued: "RUNNING",
  }),
});

export class AgentStateTransitionError extends Error {
  public readonly from: AgentState;
  public readonly reason: AgentTransitionReason;

  public constructor(from: AgentState, reason: AgentTransitionReason) {
    super(`Transition reason ${reason} is not allowed from state ${from}`);
    this.name = "AgentStateTransitionError";
    this.from = from;
    this.reason = reason;
  }
}

export class AgentStateMachine {
  readonly #clock: () => Date;
  #state: AgentState;

  public constructor(initialState: AgentState = "IDLE", clock: () => Date = () => new Date()) {
    if (!isAgentState(initialState)) {
      throw new TypeError("Initial agent state is invalid");
    }
    this.#state = initialState;
    this.#clock = clock;
  }

  public get state(): AgentState {
    return this.#state;
  }

  public can(reason: AgentTransitionReason): boolean {
    return TRANSITIONS[this.#state][reason] !== undefined;
  }

  public allowedReasons(): readonly AgentTransitionReason[] {
    return Object.freeze(
      AGENT_TRANSITION_REASONS.filter((reason) => this.can(reason)),
    );
  }

  public transition(reason: AgentTransitionReason): AgentStateTransition {
    const from = this.#state;
    const to = TRANSITIONS[from][reason];
    if (to === undefined) {
      throw new AgentStateTransitionError(from, reason);
    }

    this.#state = to;
    return Object.freeze({
      from,
      to,
      reason,
      occurredAt: this.#clock().toISOString(),
    });
  }
}
