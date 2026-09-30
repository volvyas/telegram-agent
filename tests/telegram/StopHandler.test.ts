import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { ProjectOperationStopper } from "../../src/agent/AgentManager.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import type { ProjectManager } from "../../src/projects/ProjectManager.js";
import { ProjectHandler } from "../../src/telegram/handlers/ProjectHandler.js";
import { StopHandler } from "../../src/telegram/handlers/StopHandler.js";

describe("StopHandler", () => {
  it("requires an active project", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const operations = stopper(false);

    await new StopHandler(projectHandler(), operations).handleStopCommand(context(reply));

    expect(reply).toHaveBeenCalledWith("Select a project first with /projects.");
    expect(operations.stop).not.toHaveBeenCalled();
  });

  it("is idempotent when no operation is active", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const projects = projectHandler();
    const operations = stopper(false);
    await select(projects, reply);

    await new StopHandler(projects, operations).handleStopCommand(context(reply));

    expect(operations.stop).toHaveBeenCalledExactlyOnceWith("api");
    expect(reply).toHaveBeenCalledWith("No active operation for this project.");
  });

  it("requests cancellation of the selected project only", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const projects = projectHandler();
    const operations = stopper(true);
    await select(projects, reply);

    await new StopHandler(projects, operations).handleStopCommand(context(reply));

    expect(operations.stop).toHaveBeenCalledExactlyOnceWith("api");
    expect(reply).toHaveBeenCalledWith("Stop requested.");
  });
});

function stopper(result: boolean): ProjectOperationStopper & { readonly stop: ReturnType<typeof vi.fn> } {
  return { stop: vi.fn(() => Promise.resolve(result)) };
}

function projectHandler(): ProjectHandler {
  const project: ProjectConfig = {
    id: "api", name: "API", path: "/projects/api",
    allowedOperations: new Set(["stop"]),
  };
  const manager = {
    list: () => [project],
    get: (id: string) => id === project.id ? project : undefined,
    require: () => project,
  } as unknown as ProjectManager;
  return new ProjectHandler(manager);
}

async function select(projects: ProjectHandler, reply: ReturnType<typeof vi.fn>): Promise<void> {
  await projects.handleProjectCommand({
    from: { id: 42 }, message: { text: "/project api" }, reply,
  } as unknown as Context);
  reply.mockClear();
}

function context(reply: ReturnType<typeof vi.fn>): Context {
  return { from: { id: 42 }, message: { text: "/stop" }, reply } as unknown as Context;
}
