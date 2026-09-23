import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

import type { AgentStatus } from "../../src/agent/AgentManager.js";
import type { GitStatus } from "../../src/git/GitService.js";
import { CommitHandler } from "../../src/telegram/handlers/CommitHandler.js";

describe("CommitHandler", () => {
  it("requires an active project and does not inspect Git", async () => {
    const git = { getStagedStatus: vi.fn(), commit: vi.fn() };
    const handler = new CommitHandler(
      { restoreActiveProject: vi.fn(() => Promise.resolve(undefined)) } as never,
      git,
      { getStatus: vi.fn(() => agentStatus(false)) },
      { request: vi.fn(), registerOperation: vi.fn() } as never,
    );
    const context = testContext();

    await handler.handleCommitCommand(context);

    expect(context.reply).toHaveBeenCalledWith("Select a project first with /projects.");
    expect(git.getStagedStatus).not.toHaveBeenCalled();
  });

  it("handles clean and busy projects without creating confirmation", async () => {
    const project = { id: "api", path: "/repo", allowedOperations: new Set(["commit"]) };
    const projects = { restoreActiveProject: vi.fn(() => Promise.resolve(project)) };
    const git = { getStagedStatus: vi.fn(() => Promise.resolve(status(true))), commit: vi.fn() };
    const confirmations = { request: vi.fn(), registerOperation: vi.fn() };
    const busy = new CommitHandler(
      projects as never,
      git,
      { getStatus: vi.fn(() => agentStatus(true)) },
      confirmations as never,
    );
    const busyContext = testContext();
    await busy.handleCommitCommand(busyContext);
    expect(busyContext.reply).toHaveBeenCalledWith("This project is busy with another operation.");
    expect(git.getStagedStatus).not.toHaveBeenCalled();

    const clean = new CommitHandler(
      projects as never,
      git,
      { getStatus: vi.fn(() => agentStatus(false)) },
      confirmations as never,
    );
    const cleanContext = testContext();
    await clean.handleCommitCommand(cleanContext);
    expect(cleanContext.reply).toHaveBeenCalledWith("No staged changes to commit.");
    expect(confirmations.request).not.toHaveBeenCalled();
  });

  it("shows exact preview data and creates pending confirmation for dirty trees", async () => {
    const project = { id: "api", path: "/repo", allowedOperations: new Set(["commit"]) };
    const git = { getStagedStatus: vi.fn(() => Promise.resolve(status(false))), commit: vi.fn() };
    const confirmations = { request: vi.fn(() => Promise.resolve()), registerOperation: vi.fn() };
    const handler = new CommitHandler(
      { restoreActiveProject: vi.fn(() => Promise.resolve(project)) } as never,
      git,
      { getStatus: vi.fn(() => agentStatus(false)) },
      confirmations as never,
    );
    const context = testContext();

    await handler.handleCommitCommand(context);

    expect(confirmations.request).toHaveBeenCalledWith(
      context,
      "api",
      "commit",
      "Commit preview\nBranch: feature/demo\nFiles: 3\nChanges: +7/-2, 1 binary",
      expect.any(Function),
    );
  });
});

function testContext() {
  return {
    from: { id: 42 },
    reply: vi.fn(() => Promise.resolve({ message_id: 1 })),
  } as unknown as Context & { readonly reply: ReturnType<typeof vi.fn> };
}

function agentStatus(active: boolean): AgentStatus {
  return { projectId: "api", state: active ? "RUNNING" : "IDLE", active };
}

function status(clean: boolean): GitStatus {
  return {
    branch: "feature/demo",
    clean,
    porcelain: [],
    changedFiles: clean ? [] : ["a.ts", "b.ts", "image.png"],
    numstat: {
      entries: [], filesChanged: clean ? 0 : 3, additions: clean ? 0 : 7,
      deletions: clean ? 0 : 2, binaryFiles: clean ? 0 : 1,
    },
  };
}
