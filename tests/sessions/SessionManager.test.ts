import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import type { AgentSession } from "../../src/domain/AgentSession.js";
import {
  SessionManager,
  type SessionProjectRegistry,
} from "../../src/sessions/SessionManager.js";
import { JsonStorage } from "../../src/storage/JsonStorage.js";

const timestamp = "2026-09-15T12:00:00.000Z";
const reconciliationTimestamp = "2026-09-15T12:05:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("SessionManager", () => {
  it("isolates Codex thread IDs and states for two projects", async () => {
    const storage = new JsonStorage(await createDataDirectory());
    const manager = createManager(storage);

    await Promise.all([
      manager.saveSession(session("motor", "/projects/motor", "THREAD-M", "COMPLETED")),
      manager.saveSession(session("crypto", "/projects/crypto", "THREAD-C", "STOPPED")),
    ]);

    await expect(manager.getSession("motor")).resolves.toMatchObject({
      projectId: "motor",
      threadId: "THREAD-M",
      state: "COMPLETED",
    });
    await expect(manager.getSession("crypto")).resolves.toMatchObject({
      projectId: "crypto",
      threadId: "THREAD-C",
      state: "STOPPED",
    });
    await storage.close();
  });

  it("restores a session after recreating storage and manager instances", async () => {
    const dataDirectory = await createDataDirectory();
    const firstStorage = new JsonStorage(dataDirectory);
    const firstManager = createManager(firstStorage);
    const original = session("motor", "/projects/motor", "THREAD-1", "COMPLETED");
    await firstManager.saveSession(original);
    await firstStorage.close();

    const secondStorage = new JsonStorage(dataDirectory);
    const secondManager = createManager(secondStorage);
    const restored = await secondManager.getSession("motor");

    expect(restored).toEqual({
      projectId: "motor",
      projectPath: "/projects/motor",
      state: "COMPLETED",
      threadId: "THREAD-1",
      startedAt: timestamp,
      updatedAt: timestamp,
    });
    expect(restored).not.toHaveProperty("activeRunId");
    expect(restored).not.toHaveProperty("lastEvent");
    expect(Object.isFrozen(restored)).toBe(true);
    await secondStorage.close();
  });

  it("refuses to save a session for a different canonical repository", async () => {
    const storage = new JsonStorage(await createDataDirectory());
    const manager = createManager(storage);

    await expect(
      manager.saveSession(session("motor", "/projects/replaced", "THREAD-1", "COMPLETED")),
    ).rejects.toMatchObject({
      code: "SESSION_REPOSITORY_MISMATCH",
      projectId: "motor",
    });
    await expect(manager.getSession("motor")).resolves.toBeUndefined();
    await storage.close();
  });

  it("does not restore a session when the configured canonical path changed", async () => {
    const dataDirectory = await createDataDirectory();
    const storage = new JsonStorage(dataDirectory);
    await createManager(storage).saveSession(
      session("motor", "/projects/motor", "THREAD-1", "COMPLETED"),
    );
    await storage.close();

    const reopenedStorage = new JsonStorage(dataDirectory);
    const manager = new SessionManager(
      reopenedStorage,
      registry([project("motor", "/projects/new-motor")]),
    );
    await expect(manager.getSession("motor")).rejects.toMatchObject({
      code: "SESSION_REPOSITORY_MISMATCH",
      projectId: "motor",
    });
    await reopenedStorage.close();
  });

  it("reconciles an orphaned RUNNING state while preserving its thread ID", async () => {
    const dataDirectory = await createDataDirectory();
    const firstStorage = new JsonStorage(dataDirectory);
    await createManager(firstStorage).saveSession(
      session("motor", "/projects/motor", "THREAD-RUNNING", "RUNNING"),
    );
    await firstStorage.close();

    const secondStorage = new JsonStorage(dataDirectory);
    const manager = createManager(secondStorage);
    await expect(manager.getSession("motor")).resolves.toMatchObject({
      state: "FAILED",
      threadId: "THREAD-RUNNING",
      updatedAt: reconciliationTimestamp,
    });
    await secondStorage.close();

    const thirdStorage = new JsonStorage(dataDirectory);
    await expect(createManager(thirdStorage).getSession("motor")).resolves.toMatchObject({
      state: "FAILED",
      threadId: "THREAD-RUNNING",
      updatedAt: reconciliationTimestamp,
    });
    await thirdStorage.close();
  });
});

function createManager(storage: JsonStorage): SessionManager {
  return new SessionManager(
    storage,
    registry([
      project("motor", "/projects/motor"),
      project("crypto", "/projects/crypto"),
    ]),
    { clock: () => new Date(reconciliationTimestamp) },
  );
}

function registry(projects: readonly ProjectConfig[]): SessionProjectRegistry {
  const byId = new Map(projects.map((item) => [item.id, item]));
  return {
    require(projectId) {
      const configured = byId.get(projectId);
      if (configured === undefined) throw new Error("Project not found");
      return configured;
    },
  };
}

function project(id: string, path: string): ProjectConfig {
  return { id, name: id, path, allowedOperations: new Set(["task"]) };
}

function session(
  projectId: string,
  projectPath: string,
  threadId: string,
  state: AgentSession["state"],
): AgentSession {
  const lastEvent: AgentEvent = {
    type: "completed",
    projectId,
    runId: "RUN-1",
    occurredAt: timestamp,
    summary: "Done",
  };
  return {
    projectId,
    projectPath,
    state,
    threadId,
    activeRunId: "RUN-1",
    lastEvent,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

async function createDataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-session-test-"));
  temporaryDirectories.push(root);
  return join(root, "data");
}
