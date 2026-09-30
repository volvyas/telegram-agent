import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfirmationService } from "../../src/confirmations/ConfirmationService.js";
import { SessionManager } from "../../src/sessions/SessionManager.js";
import { JsonStorage } from "../../src/storage/JsonStorage.js";
import { TaskManager } from "../../src/tasks/TaskManager.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("restart recovery", () => {
  it("fails interrupted work, preserves waiting sessions, and expires confirmations", async () => {
    const storage = new JsonStorage(await dataDirectory());
    const now = new Date("2026-09-23T12:00:00.000Z");
    await storage.update((state) => ({
      ...state,
      sessions: {
        running: {
          projectId: "running", projectPath: "/repo/running", state: "RUNNING",
          startedAt: "2026-09-23T11:59:00.000Z", updatedAt: "2026-09-23T11:59:30.000Z",
        },
        waiting: {
          projectId: "waiting", projectPath: "/repo/waiting", state: "WAITING_FOR_USER",
          updatedAt: "2026-09-23T11:59:30.000Z",
        },
      },
      tasks: [{
        id: "TASK-0001", projectId: "running", promptSummary: "safe", status: "running",
        createdAt: "2026-09-23T11:59:00.000Z", startedAt: "2026-09-23T11:59:00.000Z",
        updatedAt: "2026-09-23T11:59:00.000Z",
      }],
      confirmations: [{
        id: "expired-confirmation-001", userId: 42, projectId: "running", operation: "commit",
        createdAt: "2026-09-23T11:00:00.000Z", expiresAt: "2026-09-23T11:30:00.000Z",
      }],
    }));
    const projects = {
      require(projectId: string) {
        return { id: projectId, name: projectId, path: `/repo/${projectId}`, allowedOperations: new Set(["task"] as const) };
      },
    };

    await new SessionManager(storage, projects, { clock: () => now }).reconcileInterrupted();
    await new TaskManager(storage, { clock: () => now }).reconcileInterrupted();
    await new ConfirmationService(storage, { clock: () => now }).expireExpired();

    const state = await storage.load();
    expect(state.sessions.running?.state).toBe("FAILED");
    expect(state.sessions.waiting?.state).toBe("WAITING_FOR_USER");
    expect(state.tasks[0]).toMatchObject({ status: "failed", finishedAt: now.toISOString(), exitCode: null });
    expect(state.confirmations).toEqual([]);
    await storage.close();
  });
});

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-recovery-test-"));
  directories.push(root);
  return join(root, "data");
}
