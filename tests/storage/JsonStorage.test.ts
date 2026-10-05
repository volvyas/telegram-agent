import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonStorage } from "../../src/storage/JsonStorage.js";
import { defineStorageContract } from "./Storage.contract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

defineStorageContract("JsonStorage", async () => {
  const root = await createTemporaryDirectory();
  const dataDirectory = join(root, "nested", "data");
  return {
    create: () => Promise.resolve(new JsonStorage(dataDirectory)),
    reopen: () => Promise.resolve(new JsonStorage(dataDirectory)),
  };
});

describe("JsonStorage", () => {
  it("serializes concurrent updates without losing any", async () => {
    const root = await createTemporaryDirectory();
    const storage = new JsonStorage(join(root, "data"));
    await Promise.all(
      Array.from({ length: 50 }, async () =>
        storage.update((state) => ({
          ...state,
          sequence: { nextTaskNumber: state.sequence.nextTaskNumber + 1 },
        })),
      ),
    );
    await expect(storage.load()).resolves.toMatchObject({
      sequence: { nextTaskNumber: 51 },
    });
    expect(await readdir(join(root, "data"))).toEqual(["state.json"]);
    await storage.close();
  });

  it("reports malformed JSON as damaged and leaves it untouched", async () => {
    const root = await createTemporaryDirectory();
    const dataDirectory = join(root, "data");
    await writeState(dataDirectory, "{not-json");
    const storage = new JsonStorage(dataDirectory);
    await expect(storage.load()).rejects.toMatchObject({ code: "STORAGE_DAMAGED" });
    await expect(storage.update((state) => state)).rejects.toMatchObject({
      code: "STORAGE_DAMAGED",
    });
    expect(await readFile(join(dataDirectory, "state.json"), "utf8")).toBe("{not-json");
    await storage.close();
  });

  it("distinguishes an unsupported schema version from damaged data", async () => {
    const root = await createTemporaryDirectory();
    const dataDirectory = join(root, "data");
    await writeState(dataDirectory, JSON.stringify({ schemaVersion: 3 }));
    const storage = new JsonStorage(dataDirectory);
    await expect(storage.load()).rejects.toMatchObject({
      code: "STORAGE_UNSUPPORTED_VERSION",
    });
    await storage.close();
  });

  it("rejects structurally invalid version-one data", async () => {
    const root = await createTemporaryDirectory();
    const dataDirectory = join(root, "data");
    await writeState(dataDirectory, JSON.stringify({
      schemaVersion: 1,
      activeProjects: {},
      sessions: {},
      tasks: [],
      sequence: { nextTaskNumber: 0 },
    }));
    await expect(new JsonStorage(dataDirectory).load()).rejects.toMatchObject({
      code: "STORAGE_DAMAGED",
    });
  });

  it("migrates a valid schema-v1 session as legacy OpenAI", async () => {
    const root = await createTemporaryDirectory();
    const dataDirectory = join(root, "data");
    await writeState(dataDirectory, JSON.stringify({
      schemaVersion: 1,
      activeProjects: {},
      sessions: {
        demo: {
          projectId: "demo",
          projectPath: "/repo/demo",
          state: "COMPLETED",
          threadId: "THREAD-LEGACY",
          updatedAt: "2026-09-15T10:00:00.000Z",
        },
      },
      tasks: [],
      sequence: { nextTaskNumber: 1 },
      confirmations: [],
    }));

    const storage = new JsonStorage(dataDirectory);
    const state = await storage.load();
    expect(state.schemaVersion).toBe(2);
    expect(state.sessions.demo?.agentIdentity).toMatchObject({
      adapterKind: "codex",
      providerId: "openai",
      modelId: "",
    });
    expect(state.sessions.demo?.resumable).toBe(true);
    await storage.close();
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-remote-storage-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function writeState(dataDirectory: string, contents: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(join(dataDirectory, "state.json"), contents);
}
