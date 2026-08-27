import { describe, expect, it } from "vitest";

import {
  AGENT_STATES,
  AGENT_TRANSITION_REASONS,
  type AgentState,
  type AgentTransitionReason,
} from "../../src/agent/AgentState.js";
import {
  AgentStateMachine,
  AgentStateTransitionError,
} from "../../src/agent/AgentStateMachine.js";

interface AllowedTransitionFixture {
  readonly from: AgentState;
  readonly reason: AgentTransitionReason;
  readonly to: AgentState;
}

const allowedTransitions: readonly AllowedTransitionFixture[] = [
  { from: "IDLE", reason: "task_started", to: "RUNNING" },
  { from: "RUNNING", reason: "agent_question", to: "WAITING_FOR_USER" },
  { from: "RUNNING", reason: "turn_completed", to: "COMPLETED" },
  { from: "RUNNING", reason: "turn_failed", to: "FAILED" },
  { from: "RUNNING", reason: "stop_requested", to: "STOPPED" },
  { from: "WAITING_FOR_USER", reason: "user_answered", to: "RUNNING" },
  { from: "WAITING_FOR_USER", reason: "turn_failed", to: "FAILED" },
  { from: "WAITING_FOR_USER", reason: "stop_requested", to: "STOPPED" },
  { from: "COMPLETED", reason: "continued", to: "RUNNING" },
  { from: "FAILED", reason: "continued", to: "RUNNING" },
  { from: "STOPPED", reason: "continued", to: "RUNNING" },
];

describe("AgentStateMachine", () => {
  it.each(allowedTransitions)(
    "allows $from --$reason--> $to",
    ({ from, reason, to }) => {
      const machine = createMachine(from);

      expect(machine.can(reason)).toBe(true);
      expect(machine.transition(reason)).toEqual({
        from,
        to,
        reason,
        occurredAt: "2026-08-27T12:00:00.000Z",
      });
      expect(machine.state).toBe(to);
    },
  );

  it("supports the complete question-and-continue lifecycle", () => {
    const machine = createMachine();

    machine.transition("task_started");
    machine.transition("agent_question");
    machine.transition("user_answered");
    machine.transition("turn_completed");
    machine.transition("continued");
    machine.transition("stop_requested");

    expect(machine.state).toBe("STOPPED");
  });

  it("reports exactly the currently allowed reasons", () => {
    expect(createMachine("IDLE").allowedReasons()).toEqual(["task_started"]);
    expect(createMachine("RUNNING").allowedReasons()).toEqual([
      "agent_question",
      "turn_completed",
      "turn_failed",
      "stop_requested",
    ]);
    expect(createMachine("WAITING_FOR_USER").allowedReasons()).toEqual([
      "user_answered",
      "turn_failed",
      "stop_requested",
    ]);
    expect(createMachine("COMPLETED").allowedReasons()).toEqual(["continued"]);
  });

  it("rejects every transition not present in the transition table", () => {
    for (const state of AGENT_STATES) {
      for (const reason of AGENT_TRANSITION_REASONS) {
        const expected = allowedTransitions.some(
          (transition) => transition.from === state && transition.reason === reason,
        );
        const machine = createMachine(state);

        if (expected) {
          expect(machine.can(reason)).toBe(true);
        } else {
          expect(machine.can(reason)).toBe(false);
          expect(() => machine.transition(reason)).toThrow(AgentStateTransitionError);
          expect(machine.state).toBe(state);
        }
      }
    }
  });

  it("rejects a corrupted persisted initial state", () => {
    expect(() => createMachine("BROKEN" as AgentState)).toThrow(
      "Initial agent state is invalid",
    );
  });
});

function createMachine(initialState: AgentState = "IDLE"): AgentStateMachine {
  return new AgentStateMachine(
    initialState,
    () => new Date("2026-08-27T12:00:00.000Z"),
  );
}
