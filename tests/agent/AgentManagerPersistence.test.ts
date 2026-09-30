import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentManager,
  type AgentProjectRegistry,
} from "../../src/agent/AgentManager.js";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import type { AgentRun } from "../../src/agent/AgentRun.js";
import type {
  AgentResumeOptions,
  AgentStartOptions,
  CodingAgent,
} from "../../src/agent/CodingAgent.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import { SessionManager } from "../../src/sessions/SessionManager.js";
import { JsonStorage } from "../../src/storage/JsonStorage.js";
import { CLEAN_GIT_STATUS_READER } from "../helpers/GitStatusReader.js";

const occurredAt = "2026-09-15T14:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("AgentManager persistent resume", () => {
  it("persists a structured thread ID and resumes it after a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-remote-resume-test-"));
    temporaryDirectories.push(root);
    const dataDirectory = join(root, "data");
    const projects = registry(project("motor", "/projects/motor"));

    const firstStorage = new JsonStorage(dataDirectory);
    const firstAgent = new RecordingAgent("THREAD-1");
    const firstManager = manager(firstAgent, projects, firstStorage);
    await firstManager.startTask("motor", "Initial task");
    await firstStorage.close();

    expect(firstAgent.starts).toEqual([{
      projectId: "motor",
      workingDirectory: "/projects/motor",
      prompt: "Initial task",
    }]);
    expect(firstAgent.resumes).toEqual([]);

    const secondStorage = new JsonStorage(dataDirectory);
    const secondAgent = new RecordingAgent("THREAD-1");
    const secondManager = manager(secondAgent, projects, secondStorage);
    await secondManager.startTask("motor", "Follow-up task");

    expect(secondAgent.starts).toEqual([]);
    expect(secondAgent.resumes).toEqual([{
      projectId: "motor",
      workingDirectory: "/projects/motor",
      threadId: "THREAD-1",
      prompt: "Follow-up task",
    }]);
    await expect(new SessionManager(secondStorage, projects).getSession("motor"))
      .resolves.toMatchObject({ state: "COMPLETED", threadId: "THREAD-1" });
    await secondStorage.close();
  });
});

class RecordingAgent implements CodingAgent {
  public readonly starts: AgentStartOptions[] = [];
  public readonly resumes: AgentResumeOptions[] = [];
  readonly #threadId: string;
  #runNumber = 0;

  public constructor(threadId: string) {
    this.#threadId = threadId;
  }

  public start(options: AgentStartOptions): Promise<AgentRun> {
    this.starts.push(options);
    return Promise.resolve(this.#run(options.projectId));
  }

  public resume(options: AgentResumeOptions): Promise<AgentRun> {
    this.resumes.push(options);
    return Promise.resolve(this.#run(options.projectId));
  }

  public send(): Promise<AgentRun> {
    throw new Error("Not implemented");
  }

  public stop(): Promise<boolean> {
    return Promise.resolve(false);
  }

  #run(projectId: string): AgentRun {
    this.#runNumber += 1;
    const runId = `RUN-${String(this.#runNumber)}`;
    const threadId = this.#threadId;
    return {
      projectId,
      runId,
      events: events([
        { type: "thread_started", projectId, runId, occurredAt, threadId },
        { type: "run_started", projectId, runId, occurredAt },
        {
          type: "completed",
          projectId,
          runId,
          occurredAt,
          summary: "Done",
        },
      ]),
    };
  }
}

function manager(
  agent: CodingAgent,
  projects: AgentProjectRegistry,
  storage: JsonStorage,
): AgentManager {
  return new AgentManager(agent, projects, {
    clock: () => new Date(occurredAt),
    gitService: CLEAN_GIT_STATUS_READER,
    sessionStore: new SessionManager(storage, projects),
  });
}

function registry(configuredProject: ProjectConfig): AgentProjectRegistry {
  return {
    require(projectId) {
      if (projectId !== configuredProject.id) throw new Error("Project not found");
      return configuredProject;
    },
  };
}

function project(id: string, path: string): ProjectConfig {
  return { id, name: id, path, allowedOperations: new Set(["task"]) };
}

async function* events(items: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  await Promise.resolve();
  yield* items;
}
