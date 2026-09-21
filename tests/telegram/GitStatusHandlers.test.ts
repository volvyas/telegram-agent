import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { AgentStatus, GitStatusReader } from "../../src/agent/AgentManager.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import type { AgentSession } from "../../src/domain/AgentSession.js";
import type { GitStatus } from "../../src/git/GitService.js";
import type { ProjectManager } from "../../src/projects/ProjectManager.js";
import { GitHandler } from "../../src/telegram/handlers/GitHandler.js";
import { ProjectHandler } from "../../src/telegram/handlers/ProjectHandler.js";
import {
  StatusHandler,
  type AgentStatusReader,
} from "../../src/telegram/handlers/StatusHandler.js";

describe("GitHandler", () => {
  it("requires an active project without reading Git", async () => {
    const { projects } = createProjects();
    const git = gitReader(cleanStatus());
    const reply = vi.fn(() => Promise.resolve());

    await new GitHandler(projects, git).handleGitCommand(context(42, "/git", reply));

    expect(reply).toHaveBeenCalledWith("Select a project first with /projects.");
    expect(git.getStatus).not.toHaveBeenCalled();
  });

  it("formats a clean repository from typed service data", async () => {
    const { project, projects } = createProjects();
    const git = gitReader(cleanStatus());
    const reply = vi.fn(() => Promise.resolve());
    await selectProject(projects, reply);
    reply.mockClear();

    await new GitHandler(projects, git).handleGitCommand(context(42, "/git", reply));

    expect(git.getStatus).toHaveBeenCalledWith(project.path);
    expect(reply).toHaveBeenCalledWith([
      "Git: API (api)",
      "Branch: main",
      "Status: clean",
      "Changed files: 0",
    ].join("\n"));
  });

  it("shows staged, unstaged and escaped dirty filenames", async () => {
    const { projects } = createProjects();
    const git = gitReader(dirtyStatus());
    const reply = vi.fn(() => Promise.resolve());
    await selectProject(projects, reply);
    reply.mockClear();

    await new GitHandler(projects, git).handleGitCommand(context(42, "/git", reply));

    expect(reply).toHaveBeenCalledWith([
      "Git: API (api)",
      "Branch: feature/dashboard",
      "Status: dirty",
      "Changed files: 2",
      "Diff summary: +3/-1",
      "• [M ] staged.txt",
      "• [??] odd\\nname\\tї.txt",
    ].join("\n"));
  });
});

describe("StatusHandler", () => {
  it("requires an active project", async () => {
    const { projects } = createProjects();
    const agent = agentReader({ projectId: "api", state: "IDLE", active: false });
    const git = gitReader(cleanStatus());
    const reply = vi.fn(() => Promise.resolve());

    await new StatusHandler(projects, agent, git)
      .handleStatusCommand(context(42, "/status", reply));

    expect(reply).toHaveBeenCalledWith("Select a project first with /projects.");
    expect(agent.getStatus).not.toHaveBeenCalled();
    expect(git.getStatus).not.toHaveBeenCalled();
  });

  it("shows a running task, active session and short dirty Git summary", async () => {
    const { projects } = createProjects();
    const agent = agentReader(
      { projectId: "api", state: "RUNNING", active: true, runId: "RUN-1" },
      session("RUNNING", "THREAD-1"),
    );
    const git = gitReader(dirtyStatus());
    const reply = vi.fn(() => Promise.resolve());
    await selectProject(projects, reply);
    reply.mockClear();

    await new StatusHandler(projects, agent, git)
      .handleStatusCommand(context(42, "/status", reply));

    expect(reply).toHaveBeenCalledWith([
      "Project: API (api)",
      "Agent: RUNNING (active)",
      "Session: active",
      "Git: feature/dashboard · 2 changed, +3/-1",
    ].join("\n"));
  });

  it("shows a resumable idle session and clean repository", async () => {
    const { projects } = createProjects();
    const agent = agentReader(
      { projectId: "api", state: "COMPLETED", active: false },
      session("COMPLETED", "THREAD-1"),
    );
    const reply = vi.fn(() => Promise.resolve());
    await selectProject(projects, reply);
    reply.mockClear();

    await new StatusHandler(projects, agent, gitReader(cleanStatus()))
      .handleStatusCommand(context(42, "/status", reply));

    expect(reply).toHaveBeenCalledWith([
      "Project: API (api)",
      "Agent: COMPLETED",
      "Session: resumable",
      "Git: main · clean",
    ].join("\n"));
  });
});

function createProjects(): {
  readonly project: ProjectConfig;
  readonly projects: ProjectHandler;
} {
  const project: ProjectConfig = {
    id: "api",
    name: "API",
    path: "/projects/api",
    allowedOperations: new Set(["git", "status"]),
  };
  const manager = {
    list: () => [project],
    get: (projectId: string) => projectId === project.id ? project : undefined,
    require: (projectId: string) => {
      if (projectId !== project.id) throw new Error("Project not found");
      return project;
    },
  } as unknown as ProjectManager;
  return { project, projects: new ProjectHandler(manager) };
}

async function selectProject(projects: ProjectHandler, reply: ReturnType<typeof vi.fn>) {
  await projects.handleProjectCommand(context(42, "/project api", reply));
}

function cleanStatus(): GitStatus {
  return {
    branch: "main",
    clean: true,
    porcelain: [],
    changedFiles: [],
    numstat: {
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      binaryFiles: 0,
      entries: [],
    },
  };
}

function dirtyStatus(): GitStatus {
  return {
    branch: "feature/dashboard",
    clean: false,
    porcelain: [
      {
        path: "staged.txt",
        index: "M",
        workTree: " ",
        kind: "modified",
      },
      {
        path: "odd\nname\tї.txt",
        index: "?",
        workTree: "?",
        kind: "untracked",
      },
    ],
    changedFiles: ["staged.txt", "odd\nname\tї.txt"],
    numstat: {
      filesChanged: 1,
      additions: 3,
      deletions: 1,
      binaryFiles: 0,
      entries: [
        {
          path: "staged.txt",
          additions: 3,
          deletions: 1,
          binary: false,
        },
      ],
    },
  };
}

function gitReader(status: GitStatus): GitStatusReader & {
  readonly getStatus: ReturnType<typeof vi.fn>;
} {
  return {
    getStatus: vi.fn(() => Promise.resolve(status)),
  };
}

function agentReader(
  status: AgentStatus,
  currentSession?: AgentSession,
): AgentStatusReader & {
  readonly getStatus: ReturnType<typeof vi.fn>;
} {
  return {
    getStatus: vi.fn(() => status),
    getSession: vi.fn(() => currentSession),
  };
}

function session(state: AgentSession["state"], threadId?: string): AgentSession {
  return {
    projectId: "api",
    projectPath: "/projects/api",
    state,
    ...(threadId === undefined ? {} : { threadId }),
    updatedAt: "2026-09-21T10:00:00.000Z",
  };
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
