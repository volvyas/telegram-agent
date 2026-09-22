import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import type { GitDiffReader } from "../../src/git/GitService.js";
import type { ProjectManager } from "../../src/projects/ProjectManager.js";
import { DiffHandler } from "../../src/telegram/handlers/DiffHandler.js";
import { ProjectHandler } from "../../src/telegram/handlers/ProjectHandler.js";

describe("DiffHandler", () => {
  it("requires an active project without reading Git", async () => {
    const projects = projectHandler();
    const git = diffReader("diff");
    const reply = vi.fn(() => Promise.resolve());

    await new DiffHandler(projects, git)
      .handleDiffCommand(context(42, "/diff", reply));

    expect(reply).toHaveBeenCalledWith("Select a project first with /projects.");
    expect(git.getDiff).not.toHaveBeenCalled();
  });

  it("uses only the configured repository despite Telegram command arguments", async () => {
    const projects = projectHandler();
    const git = diffReader("diff --git a/file b/file\n+Привіт ```\n");
    const reply = vi.fn(() => Promise.resolve());
    await projects.handleProjectCommand(context(42, "/project api", reply));
    reply.mockClear();

    await new DiffHandler(projects, git)
      .handleDiffCommand(context(42, "/diff ../../private", reply));

    expect(git.getDiff).toHaveBeenCalledExactlyOnceWith("/projects/api");
    expect(reply).toHaveBeenCalledWith(
      "Diff (1/1):\ndiff --git a/file b/file\n+Привіт ```\n",
    );
  });

  it("reports an empty tracked diff", async () => {
    const projects = projectHandler();
    const reply = vi.fn(() => Promise.resolve());
    await projects.handleProjectCommand(context(42, "/project api", reply));
    reply.mockClear();

    await new DiffHandler(projects, diffReader(""))
      .handleDiffCommand(context(42, "/diff", reply));

    expect(reply).toHaveBeenCalledWith("No tracked changes.");
  });
});

function diffReader(content: string): GitDiffReader & {
  readonly getDiff: ReturnType<typeof vi.fn>;
} {
  return {
    getDiff: vi.fn(() => Promise.resolve({
      content,
      byteLength: Buffer.byteLength(content, "utf8"),
      empty: content.length === 0,
    })),
  };
}

function projectHandler(): ProjectHandler {
  const project: ProjectConfig = {
    id: "api",
    name: "API",
    path: "/projects/api",
    allowedOperations: new Set(["diff"]),
  };
  const manager = {
    list: () => [project],
    get: (projectId: string) => projectId === project.id ? project : undefined,
    require: (projectId: string) => {
      if (projectId !== project.id) throw new Error("Project not found");
      return project;
    },
  } as unknown as ProjectManager;
  return new ProjectHandler(manager);
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
