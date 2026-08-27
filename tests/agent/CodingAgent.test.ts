import { describe, expect, it } from "vitest";

import type {
  AgentEvent,
  AgentMessageOptions,
  AgentResumeOptions,
  AgentRun,
  AgentStartOptions,
  CodingAgent,
} from "../../src/agent/index.js";

describe("CodingAgent contract", () => {
  it("can be implemented and consumed without SDK or Telegram types", async () => {
    const agent: CodingAgent = new MockCodingAgent();
    const run = await agent.start({
      projectId: "motor",
      workingDirectory: "/projects/motor",
      prompt: "Add tests",
    });

    const events = await collect(run.events);

    expect(run).toMatchObject({ runId: "RUN-1", projectId: "motor" });
    expect(events).toEqual([
      expect.objectContaining({ type: "run_started", projectId: "motor" }),
      expect.objectContaining({ type: "completed", summary: "Mock completed" }),
    ]);
  });

  it("supports resume, send and idempotent stop semantics", async () => {
    const agent: CodingAgent = new MockCodingAgent();

    await expect(
      agent.resume({
        projectId: "motor",
        workingDirectory: "/projects/motor",
        threadId: "THREAD-1",
        prompt: "Continue",
      }),
    ).resolves.toMatchObject({ projectId: "motor" });
    await expect(
      agent.send({
        projectId: "motor",
        workingDirectory: "/projects/motor",
        threadId: "THREAD-1",
        message: "Use existing JWT",
      }),
    ).resolves.toMatchObject({ projectId: "motor" });
    await expect(agent.stop("RUN-1")).resolves.toBe(true);
    await expect(agent.stop("RUN-1")).resolves.toBe(false);
  });
});

class MockCodingAgent implements CodingAgent {
  readonly #activeRuns = new Set<string>();

  public start(options: AgentStartOptions): Promise<AgentRun> {
    return Promise.resolve(this.#createRun(options.projectId));
  }

  public resume(options: AgentResumeOptions): Promise<AgentRun> {
    return Promise.resolve(this.#createRun(options.projectId));
  }

  public send(options: AgentMessageOptions): Promise<AgentRun> {
    return Promise.resolve(this.#createRun(options.projectId));
  }

  public stop(runId: string): Promise<boolean> {
    return Promise.resolve(this.#activeRuns.delete(runId));
  }

  #createRun(projectId: string): AgentRun {
    const runId = "RUN-1";
    this.#activeRuns.add(runId);

    return {
      runId,
      projectId,
      events: createEvents(runId, projectId),
    };
  }
}

async function* createEvents(runId: string, projectId: string): AsyncIterable<AgentEvent> {
  await Promise.resolve();
  const occurredAt = "2026-08-27T00:00:00.000Z";
  yield { type: "run_started", runId, projectId, occurredAt };
  yield {
    type: "completed",
    runId,
    projectId,
    occurredAt,
    summary: "Mock completed",
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}
