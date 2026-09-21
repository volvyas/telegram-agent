import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentManager, type AgentProjectRegistry } from "../../src/agent/AgentManager.js";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import type { AgentRun } from "../../src/agent/AgentRun.js";
import type { AgentStartOptions, CodingAgent } from "../../src/agent/CodingAgent.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import { GitService } from "../../src/git/GitService.js";
import { allowEnvironment, ProcessRunner } from "../../src/process/ProcessRunner.js";

const temporaryDirectories: string[] = [];
const runner = new ProcessRunner();
const gitEnvironment = allowEnvironment(process.env, ["PATH", "LANG", "LC_ALL"]);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("AgentManager Git snapshots", () => {
  it("returns before/after summaries without attributing pre-existing changes", async () => {
    const repository = await createRepository();
    await appendFile(join(repository, "pre-existing.txt"), "user change\n");
    const agent = new MutatingAgent(async () => {
      await appendFile(join(repository, "pre-existing.txt"), "agent also touched this\n");
      await appendFile(join(repository, "clean-before.txt"), "observed during task\n");
      await writeFile(join(repository, "new during task\nї.txt"), "untracked\n");
    });
    const manager = new AgentManager(agent, registry(repository), {
      gitService: new GitService(),
      clock: tickingClock(),
    });

    const result = await manager.startTask("demo", "Change files");

    expect(result).toMatchObject({
      projectId: "demo",
      runId: "RUN-1",
      state: "COMPLETED",
      terminalEvent: { type: "completed", summary: "Done" },
    });
    expect(result.git.before.changedFiles).toEqual(["pre-existing.txt"]);
    expect(result.git.after.changedFiles).toEqual(
      expect.arrayContaining([
        "pre-existing.txt",
        "clean-before.txt",
        "new during task\nї.txt",
      ]),
    );
    expect(result.git.comparison).toEqual({
      attribution: "observation_only",
      preExistingChangedFiles: ["pre-existing.txt"],
      preExistingFilesStillChanged: ["pre-existing.txt"],
      observedDuringTaskFiles: expect.arrayContaining([
        "clean-before.txt",
        "new during task\nї.txt",
      ]),
      noLongerChangedFiles: [],
    });
    expect(result.git.comparison.observedDuringTaskFiles).not.toContain(
      "pre-existing.txt",
    );
    expect(result.git.after.numstat).toMatchObject({
      filesChanged: 2,
      additions: 3,
      deletions: 0,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.git.comparison.observedDuringTaskFiles)).toBe(true);
  });

  it("does not start the agent when the initial snapshot fails", async () => {
    const agent = new MutatingAgent(() => Promise.resolve());
    const manager = new AgentManager(agent, registry("/not/a/repository"), {
      gitService: new GitService(),
    });

    await expect(manager.startTask("demo", "Unsafe start")).rejects.toMatchObject({
      code: "OPERATION_FAILED",
      projectId: "demo",
    });
    expect(agent.starts).toEqual([]);
    expect(manager.getStatus("demo")).toMatchObject({ state: "IDLE", active: false });
  });
});

class MutatingAgent implements CodingAgent {
  public readonly starts: AgentStartOptions[] = [];
  readonly #mutate: () => Promise<void>;

  public constructor(mutate: () => Promise<void>) {
    this.#mutate = mutate;
  }

  public async start(options: AgentStartOptions): Promise<AgentRun> {
    this.starts.push(options);
    await this.#mutate();
    return {
      projectId: options.projectId,
      runId: "RUN-1",
      events: events([
        {
          type: "completed",
          projectId: options.projectId,
          runId: "RUN-1",
          occurredAt: "2026-09-21T10:00:03.000Z",
          summary: "Done",
        },
      ]),
    };
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

async function createRepository(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "codex-remote-snapshot-test-"));
  temporaryDirectories.push(parent);
  const repository = join(parent, "repository");
  await mkdir(repository);
  await git(repository, ["init", "-q", "-b", "main"]);
  await git(repository, ["config", "user.email", "tests@example.invalid"]);
  await git(repository, ["config", "user.name", "Test User"]);
  await writeFile(join(repository, "pre-existing.txt"), "base\n");
  await writeFile(join(repository, "clean-before.txt"), "base\n");
  await git(repository, ["add", "--", "pre-existing.txt", "clean-before.txt"]);
  await git(repository, ["commit", "-q", "-m", "initial"]);
  return repository;
}

async function git(repository: string, args: readonly string[]): Promise<void> {
  const result = await runner.run({
    executable: "git",
    args,
    cwd: repository,
    env: gitEnvironment,
  });
  expect(result.exitCode, result.stderr).toBe(0);
}

function registry(repository: string): AgentProjectRegistry {
  const project: ProjectConfig = {
    id: "demo",
    name: "Demo",
    path: repository,
    allowedOperations: new Set(["task"]),
  };
  return {
    require(projectId) {
      if (projectId !== project.id) throw new Error("Project not found");
      return project;
    },
  };
}

function tickingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 21, 10, 0, tick++));
}

async function* events(items: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  await Promise.resolve();
  yield* items;
}
