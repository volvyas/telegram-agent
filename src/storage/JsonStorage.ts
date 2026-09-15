import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  STORAGE_SCHEMA_VERSION,
  StorageError,
  createEmptyPersistedState,
  type PersistedState,
  type Storage,
  type StorageErrorCode,
  type StorageUpdate,
} from "./Storage.js";

const AGENT_STATES = new Set([
  "IDLE",
  "RUNNING",
  "WAITING_FOR_USER",
  "COMPLETED",
  "FAILED",
  "STOPPED",
]);
const TASK_STATUSES = new Set([
  "pending",
  "running",
  "waiting_for_user",
  "completed",
  "failed",
  "stopped",
]);

export class JsonStorageError extends StorageError {
  public constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "JsonStorageError";
  }
}

/** Single-process JSON storage backed by dataDirectory/state.json. */
export class JsonStorage implements Storage {
  readonly #dataDirectory: string;
  readonly #stateFile: string;
  #tail: Promise<void> = Promise.resolve();
  #state: PersistedState | undefined;
  #acceptingOperations = true;

  public constructor(dataDirectory: string, fileName = "state.json") {
    this.#dataDirectory = dataDirectory;
    this.#stateFile = join(dataDirectory, fileName);
  }

  public load(): Promise<PersistedState> {
    return this.#enqueue(async () => cloneAndFreeze(await this.#ensureLoaded()));
  }

  public update(mutator: StorageUpdate): Promise<void> {
    return this.#enqueue(async () => {
      const current = await this.#ensureLoaded();
      const candidate = mutator(cloneAndFreeze(current));
      assertPersistedState(candidate);
      await this.#writeAtomically(candidate);
      this.#state = cloneAndFreeze(candidate);
    });
  }

  public async close(): Promise<void> {
    if (!this.#acceptingOperations) {
      await this.#tail;
      return;
    }
    this.#acceptingOperations = false;
    await this.#tail;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#acceptingOperations) {
      return Promise.reject(
        new JsonStorageError("STORAGE_CLOSED", "Storage is already closed"),
      );
    }
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #ensureLoaded(): Promise<PersistedState> {
    if (this.#state !== undefined) {
      return this.#state;
    }
    let contents: string;
    try {
      contents = await readFile(this.#stateFile, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.#state = cloneAndFreeze(createEmptyPersistedState());
        return this.#state;
      }
      throw new JsonStorageError("STORAGE_READ_FAILED", "Unable to read storage state", {
        cause: error,
      });
    }

    let document: unknown;
    try {
      document = JSON.parse(contents) as unknown;
    } catch (error) {
      throw new JsonStorageError("STORAGE_DAMAGED", "Storage state is not valid JSON", {
        cause: error,
      });
    }
    if (isRecord(document) && typeof document.schemaVersion === "number" &&
        document.schemaVersion !== STORAGE_SCHEMA_VERSION) {
      throw new JsonStorageError(
        "STORAGE_UNSUPPORTED_VERSION",
        `Storage schema version ${String(document.schemaVersion)} is not supported`,
      );
    }
    try {
      assertPersistedState(document);
    } catch (error) {
      throw new JsonStorageError("STORAGE_DAMAGED", "Storage state has an invalid shape", {
        cause: error,
      });
    }
    this.#state = cloneAndFreeze(document);
    return this.#state;
  }

  async #writeAtomically(state: PersistedState): Promise<void> {
    const temporaryFile = join(
      dirname(this.#stateFile),
      `.${basename(this.#stateFile)}.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    try {
      await mkdir(this.#dataDirectory, { recursive: true, mode: 0o700 });
      const handle = await open(temporaryFile, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, undefined, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryFile, this.#stateFile);
      await syncDirectory(this.#dataDirectory);
    } catch (error) {
      await unlink(temporaryFile).catch(() => undefined);
      throw new JsonStorageError("STORAGE_WRITE_FAILED", "Unable to persist storage state", {
        cause: error,
      });
    }
  }
}

function assertPersistedState(value: unknown): asserts value is PersistedState {
  assert(isRecord(value), "state must be an object");
  assert(value.schemaVersion === STORAGE_SCHEMA_VERSION, "invalid schema version");
  assert(isRecord(value.activeProjects), "activeProjects must be an object");
  for (const [userId, activeProject] of Object.entries(value.activeProjects)) {
    assert(/^\d+$/.test(userId) && isRecord(activeProject), "invalid active project");
    assertNonEmptyString(activeProject.projectId);
    assertTimestamp(activeProject.updatedAt);
  }
  assert(isRecord(value.sessions), "sessions must be an object");
  for (const [projectId, session] of Object.entries(value.sessions)) {
    assertNonEmptyString(projectId);
    assert(isRecord(session) && session.projectId === projectId, "invalid session");
    assertNonEmptyString(session.projectPath);
    assert(AGENT_STATES.has(session.state as string), "invalid agent state");
    if (session.threadId !== undefined) assertNonEmptyString(session.threadId);
    if (session.startedAt !== undefined) assertTimestamp(session.startedAt);
    assertTimestamp(session.updatedAt);
  }
  assert(Array.isArray(value.tasks), "tasks must be an array");
  for (const task of value.tasks) {
    assert(isRecord(task), "invalid task");
    assertNonEmptyString(task.id);
    assertNonEmptyString(task.projectId);
    assert(typeof task.promptSummary === "string", "invalid prompt summary");
    assert(TASK_STATUSES.has(task.status as string), "invalid task status");
    assertTimestamp(task.createdAt);
    assertTimestamp(task.updatedAt);
  }
  assert(isRecord(value.sequence), "sequence must be an object");
  assert(
    Number.isSafeInteger(value.sequence.nextTaskNumber) &&
      (value.sequence.nextTaskNumber as number) >= 1,
    "invalid task sequence",
  );
}

function assertTimestamp(value: unknown): asserts value is string {
  assert(typeof value === "string", "timestamp must be a string");
  const date = new Date(value);
  assert(!Number.isNaN(date.valueOf()) && date.toISOString() === value, "invalid timestamp");
}

function assertNonEmptyString(value: unknown): asserts value is string {
  assert(typeof value === "string" && value.length > 0, "expected a non-empty string");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
