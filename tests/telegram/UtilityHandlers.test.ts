import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { AgentSession } from "../../src/domain/AgentSession.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import type { ProjectManager } from "../../src/projects/ProjectManager.js";
import { ContinueHandler } from "../../src/telegram/handlers/ContinueHandler.js";
import { HelpHandler } from "../../src/telegram/handlers/HelpHandler.js";
import { LogHandler } from "../../src/telegram/handlers/LogHandler.js";
import { ProjectHandler } from "../../src/telegram/handlers/ProjectHandler.js";

describe("utility command handlers", () => {
  it("help lists the configured command surface", async () => {
    const reply = vi.fn(() => Promise.resolve());
    await new HelpHandler(["status", "help", "status"]).handleHelpCommand(context(reply));
    expect(reply).toHaveBeenCalledWith("Available commands:\n/help\n/status");
  });

  it("log is bounded to recent records for the active project", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const projects = projectHandler();
    await select(projects, reply);
    const tasks = {
      recent: vi.fn(async () => [
        { id: "TASK-1", projectId: "api", promptSummary: "safe summary", status: "completed" as const, createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:01:00.000Z" },
      ]),
    };

    await new LogHandler(projects, tasks).handleLogCommand(context(reply));

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("TASK-1 · completed · safe summary"));
    expect(tasks.recent).toHaveBeenCalledWith("api", 10);
  });

  it("continue explains waiting and missing sessions", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const projects = projectHandler();
    await select(projects, reply);
    const agent = {
      getSessionForContinuation: vi.fn(async () => undefined),
      startTask: vi.fn(),
    } as never;

    await new ContinueHandler(agent, projects).handleContinueCommand(context(reply));
    expect(reply).toHaveBeenCalledWith("This project has no resumable session.");
  });

  it("continue refuses a pending question and does not start a task", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const projects = projectHandler();
    await select(projects, reply);
    const session: AgentSession = {
      projectId: "api", projectPath: "/projects/api", state: "WAITING_FOR_USER",
      threadId: "THREAD-1", updatedAt: "2026-09-22T00:00:00.000Z",
    };
    const agent = {
      getSessionForContinuation: vi.fn(async () => session),
      startTask: vi.fn(),
    } as never;

    await new ContinueHandler(agent, projects).handleContinueCommand(context(reply));
    expect(reply).toHaveBeenCalledWith("This session is waiting for an answer. Use /answer first.");
  });

  it("uses the continuation result returned by its own operation", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const projects = projectHandler();
    await select(projects, reply);
    const agent = {
      getSessionForContinuation: vi.fn(async () => ({
        projectId: "api", projectPath: "/projects/api", state: "COMPLETED",
        threadId: "THREAD-1", updatedAt: "2026-09-22T00:00:00.000Z",
      })),
      startTask: vi.fn(async () => ({
        terminalEvent: { type: "completed", summary: "Continuation complete" },
      })),
    } as never;

    await new ContinueHandler(agent, projects).handleContinueCommand(context(reply));

    expect(reply).toHaveBeenCalledWith("Task completed.\nContinuation complete");
  });
});

function projectHandler(): ProjectHandler {
  const project: ProjectConfig = {
    id: "api", name: "API", path: "/projects/api", allowedOperations: new Set(["task"]),
  };
  const manager = {
    list: () => [project], get: (id: string) => id === "api" ? project : undefined,
  } as unknown as ProjectManager;
  return new ProjectHandler(manager);
}

async function select(projects: ProjectHandler, reply: ReturnType<typeof vi.fn>): Promise<void> {
  await projects.handleProjectCommand({ from: { id: 42 }, message: { text: "/project api" }, reply } as unknown as Context);
  reply.mockClear();
}

function context(reply: ReturnType<typeof vi.fn>): Context {
  return { from: { id: 42 }, message: { text: "/command" }, reply } as unknown as Context;
}
