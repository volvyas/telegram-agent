import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";

import { AgentManagerError, type ProjectOperationCoordinator } from "../../src/agent/AgentManager.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import type { ProcessResult } from "../../src/process/ProcessRunner.js";
import type { ProjectManager } from "../../src/projects/ProjectManager.js";
import { MessageSender } from "../../src/telegram/MessageSender.js";
import { ProjectHandler } from "../../src/telegram/handlers/ProjectHandler.js";
import { TestHandler, type TestCommandRunner } from "../../src/telegram/handlers/TestHandler.js";

describe("TestHandler", () => {
  it("explains when the selected project has no test command", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const { handler, projects } = createHandler({ allowedOperations: new Set(["test"]) });
    await select(projects, reply);

    await handler.handleTestCommand(context(reply));

    expect(reply).toHaveBeenLastCalledWith("No test command is configured for this project.");
  });

  it("reports a passing configured test command", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const { handler, projects } = createHandler({
      testCommand: nodeCommand(),
    });
    await select(projects, reply);

    await handler.handleTestCommand(context(reply));

    expect(reply).toHaveBeenCalledWith("Tests started…");
    expect(reply).toHaveBeenCalledWith("Tests: passed");
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it("reports a failed configured test command", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const { handler, projects } = createHandler({
      testCommand: nodeCommand(),
    }, undefined, failedResult());
    await select(projects, reply);
    const testContext = context(reply);

    await handler.handleTestCommand(testContext);

    expect(reply).toHaveBeenCalledWith("Tests: failed (exit code 3)");
    expect(testContext.replyWithDocument).toHaveBeenCalledOnce();
  });

  it("reports a timed-out configured test command", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const { handler, projects } = createHandler({
      testCommand: nodeCommand(),
    }, undefined, timedOutResult());
    await select(projects, reply);

    await handler.handleTestCommand(context(reply));

    expect(reply).toHaveBeenCalledWith("Tests: timed out");
  });

  it("does not start tests when the project is busy", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const coordinator: ProjectOperationCoordinator = {
      runExclusive: vi.fn(() => Promise.reject(new AgentManagerError(
        "OPERATION_ACTIVE", "busy", "api",
      ))),
    };
    const { handler, projects } = createHandler({
      testCommand: nodeCommand(),
    }, coordinator);
    await select(projects, reply);

    await handler.handleTestCommand(context(reply));

    expect(reply).toHaveBeenCalledWith("This project is busy with another operation.");
  });
});

function createHandler(
  overrides: Partial<ProjectConfig>,
  coordinator: ProjectOperationCoordinator = {
    runExclusive: (_id, _name, action) => action(new AbortController().signal),
  },
  result: ProcessResult = passingResult(),
): { readonly handler: TestHandler; readonly projects: ProjectHandler } {
  const project: ProjectConfig = {
    id: "api",
    name: "API",
    path: process.cwd(),
    allowedOperations: new Set(["test"]),
    ...overrides,
  };
  const manager = {
    list: () => [project],
    get: (projectId: string) => projectId === project.id ? project : undefined,
    require: (projectId: string) => {
      if (projectId !== project.id) throw new Error("Project not found");
      return project;
    },
  } as unknown as ProjectManager;
  const projects = new ProjectHandler(manager);
  return {
    projects,
    handler: new TestHandler(
      projects,
      commandRunner(result),
      coordinator,
      new MessageSender(),
    ),
  };
}

function nodeCommand() {
  return { executable: "test", args: [] };
}

function commandRunner(result: ProcessResult): TestCommandRunner {
  return { run: vi.fn(() => Promise.resolve(result)) };
}

function passingResult(): ProcessResult {
  return {
    exitCode: 0, signal: null, stdout: "all good", stderr: "",
    stdoutTruncated: false, stderrTruncated: false, durationMs: 12,
  };
}

function timedOutResult(): ProcessResult {
  return {
    exitCode: null, signal: "SIGTERM", stdout: "", stderr: "",
    stdoutTruncated: false, stderrTruncated: false, durationMs: 20,
    terminationReason: "timed_out",
  };
}

function failedResult(): ProcessResult {
  return {
    exitCode: 3, signal: null, stdout: "", stderr: "broken",
    stdoutTruncated: false, stderrTruncated: false, durationMs: 15,
  };
}

async function select(projects: ProjectHandler, reply: ReturnType<typeof vi.fn>): Promise<void> {
  await projects.handleProjectCommand({
    from: { id: 42 }, message: { text: "/project api" }, reply,
  } as unknown as Context);
  reply.mockClear();
}

function context(reply: ReturnType<typeof vi.fn>): Context & {
  readonly replyWithDocument: ReturnType<typeof vi.fn>;
} {
  return {
    from: { id: 42 },
    message: { text: "/test hostile command text" },
    reply,
    replyWithDocument: vi.fn(() => Promise.resolve()),
  } as unknown as Context & { readonly replyWithDocument: ReturnType<typeof vi.fn> };
}
