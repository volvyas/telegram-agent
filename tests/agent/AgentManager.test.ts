import { describe, expect, it, vi } from "vitest";

import {
  AgentManager,
  type AgentProjectRegistry,
} from "../../src/agent/AgentManager.js";
import type { AgentManagerError } from "../../src/agent/AgentManager.js";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import type { AgentRun } from "../../src/agent/AgentRun.js";
import type {
  AgentStartOptions,
  CodingAgent,
} from "../../src/agent/CodingAgent.js";
import type { AllowedOperation, ProjectConfig } from "../../src/config/ProjectConfig.js";
import { CLEAN_GIT_STATUS_READER } from "../helpers/GitStatusReader.js";

const occurredAt = "2026-08-28T10:00:00.000Z";

describe("AgentManager", () => {
  it("tracks the complete lifecycle, session and delivered events", async () => {
    const delivered: AgentEvent[] = [];
    const agent = new FakeCodingAgent((options) => run(options.projectId, "RUN-1", [
      event("thread_started", options.projectId, "RUN-1", { threadId: "THREAD-1" }),
      event("run_started", options.projectId, "RUN-1"),
      event("progress", options.projectId, "RUN-1", { message: "Editing" }),
      event("completed", options.projectId, "RUN-1", { summary: "Done" }),
    ]));
    const manager = createManager(agent, (item) => {
      delivered.push(item);
    });

    expect(manager.getStatus("motor")).toEqual({
      projectId: "motor",
      state: "IDLE",
      active: false,
    });

    await manager.startTask("motor", "Implement feature");

    expect(agent.starts).toEqual([{
      projectId: "motor",
      workingDirectory: "/projects/motor",
      prompt: "Implement feature",
    }]);
    expect(delivered.map(({ type }) => type)).toEqual([
      "thread_started",
      "run_started",
      "progress",
      "completed",
    ]);
    expect(manager.getStatus("motor")).toEqual({
      projectId: "motor",
      state: "COMPLETED",
      active: false,
    });
    expect(manager.getSession("motor")).toMatchObject({
      projectId: "motor",
      projectPath: "/projects/motor",
      state: "COMPLETED",
      threadId: "THREAD-1",
      lastEvent: { type: "completed", summary: "Done" },
    });
    expect(manager.getSession("motor")).not.toHaveProperty("activeRunId");
    expect(Object.isFrozen(manager.getSession("motor"))).toBe(true);
  });

  it("rejects a second operation for one project and releases the lock", async () => {
    const motorGate = deferredEvents();
    let startCount = 0;
    const agent = new FakeCodingAgent((options) => {
      startCount += 1;
      const runId = `RUN-${options.projectId}`;
      return run(
        options.projectId,
        runId,
        startCount === 1
          ? motorGate.events
          : [event("completed", options.projectId, runId, { summary: "Done again" })],
      );
    });
    const manager = createManager(agent);

    const first = manager.startTask("motor", "First");
    await vi.waitFor(() => {
      expect(manager.getStatus("motor")).toMatchObject({ state: "RUNNING", active: true });
    });

    await expect(manager.startTask("motor", "Second")).rejects.toMatchObject({
      code: "OPERATION_ACTIVE",
      projectId: "motor",
    });

    motorGate.push(event("completed", "motor", "RUN-motor", { summary: "Done" }));
    motorGate.end();
    await first;

    await expect(manager.startTask("motor", "After completion")).resolves.toMatchObject({
      projectId: "motor",
      state: "COMPLETED",
    });
  });

  it("stops an active task without discarding its resumable session", async () => {
    const gate = deferredEvents();
    const delivered: AgentEvent[] = [];
    const agent = new FakeCodingAgent((options) => run(
      options.projectId,
      "RUN-motor",
      gate.events,
    ));
    const manager = createManager(agent, (item) => delivered.push(item));

    const running = manager.startTask("motor", "Stop me");
    await vi.waitFor(() => {
      expect(manager.getStatus("motor")).toMatchObject({ active: true, runId: "RUN-motor" });
    });

    await expect(manager.stop("motor")).resolves.toBe(true);
    expect(agent.stops).toEqual(["RUN-motor"]);
    expect(manager.getStatus("motor")).toMatchObject({ state: "STOPPED", active: true });

    gate.push(event("completed", "motor", "RUN-motor", { summary: "Late completion" }));
    gate.end();
    await expect(running).resolves.toMatchObject({
      state: "STOPPED",
      terminalEvent: { type: "stopped", reason: "user" },
    });

    expect(delivered.map((item) => item.type)).toEqual(["stopped"]);
    expect(manager.getSession("motor")).toMatchObject({
      state: "STOPPED",
      lastEvent: { type: "stopped" },
    });
    expect(manager.getSession("motor")).not.toHaveProperty("activeRunId");
    await expect(manager.stop("motor")).resolves.toBe(false);
  });

  it("honors stop requested before the coding agent returns a run ID", async () => {
    let resolveRun: ((run: AgentRun) => void) | undefined;
    const agent = new FakeCodingAgent((_options) => new Promise<AgentRun>((resolve) => {
      resolveRun = resolve;
    }));
    const manager = createManager(agent);
    const running = manager.startTask("motor", "Stop during startup");
    await vi.waitFor(() => expect(agent.starts).toHaveLength(1));

    await expect(manager.stop("motor")).resolves.toBe(true);
    resolveRun?.(run("motor", "RUN-late", [
      event("completed", "motor", "RUN-late", { summary: "Must be ignored" }),
    ]));

    await expect(running).resolves.toMatchObject({
      state: "STOPPED",
      terminalEvent: { type: "stopped" },
    });
    expect(agent.stops).toEqual(["RUN-late"]);
    expect(manager.getStatus("motor")).toMatchObject({ active: false, state: "STOPPED" });
  });

  it("allows different projects to run concurrently", async () => {
    const gates = new Map([
      ["motor", deferredEvents()],
      ["crypto", deferredEvents()],
    ]);
    const agent = new FakeCodingAgent((options) => run(
      options.projectId,
      `RUN-${options.projectId}`,
      requireGate(gates, options.projectId).events,
    ));
    const manager = createManager(agent);

    const motor = manager.startTask("motor", "Motor task");
    const crypto = manager.startTask("crypto", "Crypto task");
    await vi.waitFor(() => {
      expect(manager.getStatus("motor").active).toBe(true);
      expect(manager.getStatus("crypto").active).toBe(true);
    });

    for (const projectId of ["motor", "crypto"] as const) {
      const gate = requireGate(gates, projectId);
      gate.push(
        event("completed", projectId, `RUN-${projectId}`, { summary: "Done" }),
      );
      gate.end();
    }
    await Promise.all([motor, crypto]);

    expect(manager.getStatus("motor").state).toBe("COMPLETED");
    expect(manager.getStatus("crypto").state).toBe("COMPLETED");
  });

  it("marks a failed start and makes the project available again", async () => {
    const failure = new Error("SDK secret details");
    const agent = new FakeCodingAgent(() => Promise.reject(failure));
    const manager = createManager(agent);

    await expect(manager.startTask("motor", "Fail")).rejects.toEqual(
      expect.objectContaining<Partial<AgentManagerError>>({
        code: "OPERATION_FAILED",
        projectId: "motor",
        cause: failure,
      }),
    );
    expect(manager.getStatus("motor")).toMatchObject({ state: "FAILED", active: false });

    await expect(manager.startTask("motor", "Retry")).rejects.not.toMatchObject({
      code: "OPERATION_ACTIVE",
    });
    expect(agent.starts).toHaveLength(2);
  });

  it("maps fatal, stopped and question outcomes to session states", async () => {
    const outcomes: readonly [AgentEvent, string][] = [
      [event("error", "motor", "RUN-1", { message: "Failed", fatal: true }), "FAILED"],
      [event("stopped", "motor", "RUN-2", { reason: "user" }), "STOPPED"],
      [
        event("question", "motor", "RUN-3", {
          questionId: "Q-1",
          question: "Which option?",
          choices: [],
        }),
        "WAITING_FOR_USER",
      ],
    ];

    for (const [index, [outcome, expectedState]] of outcomes.entries()) {
      const runId = `RUN-${String(index + 1)}`;
      const agent = new FakeCodingAgent((options) => run(options.projectId, runId, [outcome]));
      const manager = createManager(agent);

      await manager.startTask("motor", "Task");

      expect(manager.getStatus("motor").state).toBe(expectedState);
    }
  });

  it("does not replace a session that is waiting for an answer", async () => {
    const agent = new FakeCodingAgent((options) => run(options.projectId, "RUN-1", [
      event("question", options.projectId, "RUN-1", {
        questionId: "Q-1",
        question: "Continue?",
        choices: [],
      }),
    ]));
    const manager = createManager(agent);
    await manager.startTask("motor", "Task");

    await expect(manager.startTask("motor", "Unrelated task")).rejects.toMatchObject({
      code: "SESSION_WAITING_FOR_USER",
    });
    expect(manager.getStatus("motor")).toMatchObject({
      state: "WAITING_FOR_USER",
      active: false,
    });
    expect(agent.starts).toHaveLength(1);
  });

  it("rejects projects without task permission before invoking the agent", async () => {
    const agent = new FakeCodingAgent((options) =>
      run(options.projectId, "RUN-1", []),
    );
    const manager = new AgentManager(agent, registry([
      project("motor", "/projects/motor", ["status"]),
    ]));

    await expect(manager.startTask("motor", "Task")).rejects.toMatchObject({
      code: "TASK_NOT_ALLOWED",
    });
    expect(agent.starts).toEqual([]);
  });

  it("requests cancellation for every active run during shutdown", async () => {
    const gates = new Map([
      ["motor", deferredEvents()],
      ["crypto", deferredEvents()],
    ]);
    const agent = new FakeCodingAgent((options) => run(
      options.projectId,
      `RUN-${options.projectId}`,
      requireGate(gates, options.projectId).events,
    ));
    const manager = createManager(agent);
    const operations = [
      manager.startTask("motor", "Task"),
      manager.startTask("crypto", "Task"),
    ];
    await vi.waitFor(() => {
      expect(manager.getStatus("motor").runId).toBe("RUN-motor");
      expect(manager.getStatus("crypto").runId).toBe("RUN-crypto");
    });

    const stopped = manager.stopAll();
    await vi.waitFor(() => {
      expect(agent.stops).toEqual(expect.arrayContaining(["RUN-motor", "RUN-crypto"]));
    });
    expect(agent.stops).toEqual(expect.arrayContaining(["RUN-motor", "RUN-crypto"]));
    for (const [projectId, gate] of gates) {
      gate.push(event("stopped", projectId, `RUN-${projectId}`, { reason: "shutdown" }));
      gate.end();
    }
    await stopped;
    await Promise.all(operations);
  });
});

class FakeCodingAgent implements CodingAgent {
  public readonly starts: AgentStartOptions[] = [];
  public readonly stops: string[] = [];
  readonly #start: (options: AgentStartOptions) => AgentRun | Promise<AgentRun>;

  public constructor(start: (options: AgentStartOptions) => AgentRun | Promise<AgentRun>) {
    this.#start = start;
  }

  public start(options: AgentStartOptions): Promise<AgentRun> {
    this.starts.push(options);
    return Promise.resolve(this.#start(options));
  }

  public resume(): Promise<AgentRun> {
    throw new Error("Not implemented");
  }

  public send(): Promise<AgentRun> {
    throw new Error("Not implemented");
  }

  public stop(runId: string): Promise<boolean> {
    this.stops.push(runId);
    return Promise.resolve(true);
  }
}

function createManager(agent: CodingAgent, onEvent?: (event: AgentEvent) => void): AgentManager {
  return new AgentManager(
    agent,
    registry([
      project("motor", "/projects/motor"),
      project("crypto", "/projects/crypto"),
    ]),
    {
      clock: () => new Date(occurredAt),
      gitService: CLEAN_GIT_STATUS_READER,
      ...(onEvent === undefined ? {} : { onEvent }),
    },
  );
}

function registry(projects: readonly ProjectConfig[]): AgentProjectRegistry {
  const byId = new Map(projects.map((item) => [item.id, item]));
  return {
    require(projectId) {
      const configured = byId.get(projectId);
      if (configured === undefined) {
        throw new Error("Project not found");
      }
      return configured;
    },
  };
}

function project(
  id: string,
  path: string,
  operations: readonly AllowedOperation[] = ["task"],
): ProjectConfig {
  return {
    id,
    name: id,
    path,
    allowedOperations: new Set(operations),
  };
}

function requireGate(
  gates: ReadonlyMap<string, ReturnType<typeof deferredEvents>>,
  projectId: string,
): ReturnType<typeof deferredEvents> {
  const gate = gates.get(projectId);
  if (gate === undefined) {
    throw new Error(`Missing event gate for ${projectId}`);
  }
  return gate;
}

function run(
  projectId: string,
  runId: string,
  events: readonly AgentEvent[] | AsyncIterable<AgentEvent>,
): AgentRun {
  return {
    projectId,
    runId,
    events: Symbol.asyncIterator in events ? events : fromArray(events),
  };
}

async function* fromArray(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  await Promise.resolve();
  yield* events;
}

function event(
  type: AgentEvent["type"],
  projectId: string,
  runId: string,
  fields: Record<string, unknown> = {},
): AgentEvent {
  return { type, projectId, runId, occurredAt, ...fields } as AgentEvent;
}

function deferredEvents(): {
  readonly events: AsyncIterable<AgentEvent>;
  push(event: AgentEvent): void;
  end(): void;
} {
  const queued: AgentEvent[] = [];
  let resume: (() => void) | undefined;
  let ended = false;
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        while (!ended || queued.length > 0) {
          const next = queued.shift();
          if (next !== undefined) {
            yield next;
          } else {
            await new Promise<void>((resolve) => {
              resume = resolve;
            });
          }
        }
      },
    },
    push(item) {
      queued.push(item);
      resume?.();
      resume = undefined;
    },
    end() {
      ended = true;
      resume?.();
      resume = undefined;
    },
  };
}
