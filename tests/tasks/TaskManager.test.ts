import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GitTaskSnapshot } from "../../src/domain/GitSnapshot.js";
import { JsonStorage } from "../../src/storage/JsonStorage.js";
import { TaskIdGenerator } from "../../src/tasks/TaskIdGenerator.js";
import { TaskManager } from "../../src/tasks/TaskManager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("TaskIdGenerator", () => {
  it("does not repeat IDs across concurrent reservations or restart", async () => {
    const data = await temporaryDataDirectory();
    const storage = new JsonStorage(data);
    const generator = new TaskIdGenerator(storage);

    const ids = await Promise.all(Array.from({ length: 25 }, () => generator.generate()));
    expect(new Set(ids).size).toBe(25);
    expect(ids).toContain("TASK-0001");
    expect(ids).toContain("TASK-0025");
    await storage.close();

    const reopened = new JsonStorage(data);
    await expect(new TaskIdGenerator(reopened).generate()).resolves.toBe("TASK-0026");
    await reopened.close();
  });
});

describe("TaskManager", () => {
  it("atomically creates bounded summaries without retaining the prompt", async () => {
    const storage = new JsonStorage(await temporaryDataDirectory());
    const manager = new TaskManager(storage, { clock: clock("2026-09-23T10:00:00.000Z") });
    const prompt = `  Implement\n${"private ".repeat(40)}\u0000tail  `;

    const task = await manager.start("api", prompt);
    const state = await storage.load();

    expect(task.id).toBe("TASK-0001");
    expect(task.promptSummary.length).toBeLessThanOrEqual(160);
    expect(task.promptSummary).not.toContain("\n");
    expect(JSON.stringify(state)).not.toContain(prompt);
    expect(state.sequence.nextTaskNumber).toBe(2);
    await storage.close();
  });

  it("persists terminal metadata and returns newest project history first", async () => {
    const storage = new JsonStorage(await temporaryDataDirectory());
    const times = [
      "2026-09-23T10:00:00.000Z",
      "2026-09-23T10:00:02.250Z",
      "2026-09-23T10:00:03.000Z",
    ];
    const manager = new TaskManager(storage, { clock: () => new Date(times.shift() ?? "2026-09-23T10:00:04.000Z") });
    const first = await manager.start("api", "First task");
    const completed = await manager.finish(first.id, {
      status: "completed",
      exitCode: 0,
      testSummary: { status: "passed", durationMs: 80, exitCode: 0 },
      git: gitSnapshot(),
    });
    await manager.start("web", "Other project");

    expect(completed).toMatchObject({
      status: "completed",
      durationMs: 2_250,
      exitCode: 0,
      testSummary: { status: "passed", durationMs: 80, exitCode: 0 },
      gitSummary: { changedFiles: 2, additions: 4, deletions: 1, observedDuringTaskFiles: 1 },
    });
    await expect(manager.recent("api", 10)).resolves.toEqual([completed]);
    await storage.close();
  });
});

async function temporaryDataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-tasks-test-"));
  temporaryDirectories.push(root);
  return join(root, "data");
}

function clock(timestamp: string): () => Date {
  return () => new Date(timestamp);
}

function gitSnapshot(): GitTaskSnapshot {
  return {
    before: {
      capturedAt: "2026-09-23T10:00:00.000Z", branch: "main", clean: true,
      porcelain: [], changedFiles: [], numstat: { entries: [], filesChanged: 0, additions: 0, deletions: 0, binaryFiles: 0 },
    },
    after: {
      capturedAt: "2026-09-23T10:00:02.000Z", branch: "main", clean: false,
      porcelain: [], changedFiles: ["a.ts", "b.ts"], numstat: { entries: [], filesChanged: 2, additions: 4, deletions: 1, binaryFiles: 0 },
    },
    comparison: {
      attribution: "observation_only", preExistingChangedFiles: [], preExistingFilesStillChanged: [],
      observedDuringTaskFiles: ["a.ts"], noLongerChangedFiles: [],
    },
  };
}
