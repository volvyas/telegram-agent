import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";

import { AgentManager } from "../../src/agent/AgentManager.js";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import type { AgentRun } from "../../src/agent/AgentRun.js";
import type { AgentStartOptions, CodingAgent } from "../../src/agent/CodingAgent.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import type { ProjectManager } from "../../src/projects/ProjectManager.js";
import { ProjectHandler } from "../../src/telegram/handlers/ProjectHandler.js";
import { TaskHandler } from "../../src/telegram/handlers/TaskHandler.js";
import { CLEAN_GIT_STATUS_READER } from "../helpers/GitStatusReader.js";

describe("TaskHandler", () => {
  it("does not start a task without an active project", async () => {
    const { agent, handler } = createHandler();
    const reply = vi.fn(() => Promise.resolve());

    await handler.handleTaskCommand(context(42, "/task Make it work", reply));

    expect(agent.starts).toEqual([]);
    expect(reply).toHaveBeenCalledWith("Select a project first with /projects.");
  });

  it("supports /task followed by the next text message", async () => {
    const { agent, handler, projects } = createHandler();
    const reply = vi.fn(() => Promise.resolve());
    await projects.handleProjectCommand(context(42, "/project api", reply));

    await handler.handleTaskCommand(context(42, "/task", reply));
    await handler.handleText(context(42, "Use $HOME; rm -rf /", reply));

    expect(agent.starts[0]?.prompt).toBe("Use $HOME; rm -rf /");
    expect(reply).toHaveBeenCalledWith("Send the task description in your next message.");
    expect(reply).toHaveBeenCalledWith("Task completed.\nImplemented safely");
  });

  it("reports a terminal agent failure", async () => {
    const { handler, projects } = createHandler("error");
    const reply = vi.fn(() => Promise.resolve());
    await projects.handleProjectCommand(context(42, "/project api", reply));

    await handler.handleTaskCommand(context(42, "/task Break", reply));

    expect(reply).toHaveBeenCalledWith("Task failed.\nCodex failed");
  });
});

class FakeAgent implements CodingAgent {
  public readonly starts: AgentStartOptions[] = [];
  readonly #outcome: "completed" | "error";

  public constructor(outcome: "completed" | "error") {
    this.#outcome = outcome;
  }

  public start(options: AgentStartOptions): Promise<AgentRun> {
    this.starts.push(options);
    return Promise.resolve({
      projectId: options.projectId,
      runId: "RUN-1",
      events: events(options.projectId, this.#outcome),
    });
  }

  public resume(): Promise<AgentRun> {
    throw new Error("Not implemented");
  }

  public send(): Promise<AgentRun> {
    throw new Error("Not implemented");
  }

  public stop(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function createHandler(outcome: "completed" | "error" = "completed") {
  const agent = new FakeAgent(outcome);
  const manager = projectManager();
  const projects = new ProjectHandler(manager);
  const handler = new TaskHandler(
    new AgentManager(agent, manager, { gitService: CLEAN_GIT_STATUS_READER }),
    projects,
  );
  return { agent, handler, projects };
}

async function* events(
  projectId: string,
  outcome: "completed" | "error",
): AsyncIterable<AgentEvent> {
  await Promise.resolve();
  const base = { projectId, runId: "RUN-1", occurredAt: "2026-09-14T00:00:00Z" };
  yield outcome === "completed"
    ? { ...base, type: "completed", summary: "Implemented safely" }
    : { ...base, type: "error", message: "Codex failed", fatal: true };
}

function context(
  userId: number,
  text: string,
  reply: ReturnType<typeof vi.fn>,
): Context {
  return {
    from: { id: userId },
    message: { text },
    reply,
  } as unknown as Context;
}

function projectManager(): ProjectManager {
  const project: ProjectConfig = {
    id: "api",
    name: "API",
    path: "/projects/api",
    allowedOperations: new Set(["task"]),
  };
  return {
    list: () => [project],
    get: (projectId: string) => projectId === project.id ? project : undefined,
    require: (projectId: string) => {
      if (projectId !== project.id) throw new Error("Project not found");
      return project;
    },
  } as unknown as ProjectManager;
}
