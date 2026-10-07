import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  STORAGE_SCHEMA_VERSION,
  LEGACY_STORAGE_SCHEMA_VERSION,
  StorageError,
  createEmptyPersistedState,
  type PersistedState,
  type Storage,
  type StorageErrorCode,
  type StorageUpdate,
} from "./Storage.js";
import { legacyOpenAiAgentIdentity } from "../domain/AgentIdentity.js";
import { parseActorId, telegramActorId } from "../domain/Actor.js";

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
    if (!isAbsolute(dataDirectory)) {
      throw new TypeError("Storage directory must be absolute");
    }
    if (fileName.length === 0 || fileName.includes("\0") || basename(fileName) !== fileName) {
      throw new TypeError("Storage file name must not leave the storage directory");
    }
    this.#dataDirectory = resolve(dataDirectory);
    this.#stateFile = join(this.#dataDirectory, fileName);
  }

  public load(): Promise<PersistedState> {
    return this.#enqueue(async () => cloneAndFreeze(await this.#ensureLoaded()));
  }

  public update(mutator: StorageUpdate): Promise<void> {
    return this.#enqueue(async () => {
      const current = await this.#ensureLoaded();
      const candidate = normalizeLegacyActors(normalizeLegacySessionIdentities(mutator(cloneAndFreeze(current))));
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
    await this.#secureStoragePaths();
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
    const shouldMigrateLegacy = isRecord(document) && document.schemaVersion === LEGACY_STORAGE_SCHEMA_VERSION;
    if (isRecord(document) && typeof document.schemaVersion === "number" &&
        document.schemaVersion !== STORAGE_SCHEMA_VERSION &&
        document.schemaVersion !== LEGACY_STORAGE_SCHEMA_VERSION) {
      throw new JsonStorageError(
        "STORAGE_UNSUPPORTED_VERSION",
        `Storage schema version ${String(document.schemaVersion)} is not supported`,
      );
    }
    try {
      if (isRecord(document) && document.schemaVersion === LEGACY_STORAGE_SCHEMA_VERSION) {
        document = migrateSchemaV1(document);
      }
      // DEV-035 state files predate confirmations. Keep old files readable and
      // normalize the new collection before validating the document.
      if (isRecord(document) && document.confirmations === undefined) {
        document = { ...document, confirmations: [] };
      }
      document = normalizeLegacyActors(normalizeLegacySessionIdentities(document));
      assertPersistedState(document);
    } catch (error) {
      throw new JsonStorageError("STORAGE_DAMAGED", "Storage state has an invalid shape", {
        cause: error,
      });
    }
    const migrated = cloneAndFreeze(document);
    if (shouldMigrateLegacy) {
      await this.#writeAtomically(migrated);
    }
    this.#state = migrated;
    return this.#state;
  }

  async #writeAtomically(state: PersistedState): Promise<void> {
    const temporaryFile = join(
      dirname(this.#stateFile),
      `.${basename(this.#stateFile)}.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    try {
      await this.#secureStoragePaths();
      const handle = await open(temporaryFile, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, undefined, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryFile, this.#stateFile);
      await chmod(this.#stateFile, 0o600);
      await syncDirectory(this.#dataDirectory);
    } catch (error) {
      await unlink(temporaryFile).catch(() => undefined);
      throw new JsonStorageError("STORAGE_WRITE_FAILED", "Unable to persist storage state", {
        cause: error,
      });
    }
  }

  async #secureStoragePaths(): Promise<void> {
    try {
      await mkdir(this.#dataDirectory, { recursive: true, mode: 0o700 });
      const directoryStat = await lstat(this.#dataDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new JsonStorageError(
          "STORAGE_READ_FAILED",
          "Storage directory must be a real directory",
        );
      }
      await chmod(this.#dataDirectory, 0o700);

      try {
        const stateStat = await lstat(this.#stateFile);
        if (!stateStat.isFile() || stateStat.isSymbolicLink()) {
          throw new JsonStorageError(
            "STORAGE_READ_FAILED",
            "Storage state must be a regular file",
          );
        }
        await chmod(this.#stateFile, 0o600);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    } catch (error) {
      if (error instanceof JsonStorageError) throw error;
      throw new JsonStorageError(
        "STORAGE_READ_FAILED",
        "Unable to secure storage paths",
        { cause: error },
      );
    }
  }
}

function assertPersistedState(value: unknown): asserts value is PersistedState {
  assert(isRecord(value), "state must be an object");
  assert(value.schemaVersion === STORAGE_SCHEMA_VERSION, "invalid schema version");
  assert(isRecord(value.activeProjects), "activeProjects must be an object");
  for (const [userId, activeProject] of Object.entries(value.activeProjects)) {
    assert((parseActorId(userId) !== undefined || /^\d+$/u.test(userId)) && isRecord(activeProject), "invalid active project actor");
    assert(activeProject.actorId === undefined || activeProject.actorId === (parseActorId(userId) ?? telegramActorId(Number(userId))), "active project actor mismatch");
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
    assertAgentIdentity(session.agentIdentity);
    if (session.resumable !== undefined) assert(typeof session.resumable === "boolean", "invalid session resumable flag");
    if (session.historicalThreadId !== undefined) assertNonEmptyString(session.historicalThreadId);
    if (session.resumeDiagnostic !== undefined) assert(session.resumeDiagnostic === "AGENT_IDENTITY_CHANGED", "invalid session diagnostic");
    if (session.pendingQuestion !== undefined) {
      const question = session.pendingQuestion;
      assert(isRecord(question), "invalid pending question");
      assertNonEmptyString(question.questionId);
      assertNonEmptyString(question.question);
      assert(Array.isArray(question.choices), "invalid question choices");
      for (const choice of question.choices) assertNonEmptyString(choice);
      if (question.actorId !== undefined) assert(parseActorId(question.actorId) !== undefined, "invalid question actor");
      assertTimestamp(question.createdAt);
    }
  }
  assert(Array.isArray(value.tasks), "tasks must be an array");
  for (const task of value.tasks) {
    assert(isRecord(task), "invalid task");
    assertNonEmptyString(task.id);
    assertNonEmptyString(task.projectId);
    assert(typeof task.promptSummary === "string", "invalid prompt summary");
    assert(TASK_STATUSES.has(task.status as string), "invalid task status");
    assertTimestamp(task.createdAt);
    if (task.startedAt !== undefined) assertTimestamp(task.startedAt);
    if (task.finishedAt !== undefined) assertTimestamp(task.finishedAt);
    assertTimestamp(task.updatedAt);
    if (task.durationMs !== undefined) assertNonNegativeInteger(task.durationMs, "invalid task duration");
    if (task.exitCode !== undefined && task.exitCode !== null) assertInteger(task.exitCode, "invalid task exit code");
    if (task.testSummary !== undefined) assertTestSummary(task.testSummary);
    if (task.gitSummary !== undefined) assertGitSummary(task.gitSummary);
  }
  assert(isRecord(value.sequence), "sequence must be an object");
  assert(
    Number.isSafeInteger(value.sequence.nextTaskNumber) &&
      (value.sequence.nextTaskNumber as number) >= 1,
    "invalid task sequence",
  );
  assert(Array.isArray(value.confirmations), "confirmations must be an array");
  for (const confirmation of value.confirmations) {
    assert(isRecord(confirmation), "invalid confirmation");
    assertNonEmptyString(confirmation.id);
    assert(parseActorId(confirmation.actorId) !== undefined, "invalid confirmation actor");
    assertNonEmptyString(confirmation.projectId);
    assertNonEmptyString(confirmation.operation);
    assertTimestamp(confirmation.createdAt);
    assertTimestamp(confirmation.expiresAt);
    assert(new Date(confirmation.expiresAt).valueOf() > new Date(confirmation.createdAt).valueOf(), "invalid confirmation expiry");
  }
}

function assertAgentIdentity(value: unknown): void {
  assert(isRecord(value), "invalid agent identity");
  assert(value.adapterKind === "codex", "invalid agent adapter kind");
  assertNonEmptyString(value.providerId);
  assert(typeof value.modelId === "string", "invalid agent model ID");
  assert(/^[a-f0-9]{64}$/u.test(value.providerFingerprint as string), "invalid provider fingerprint");
}

function migrateSchemaV1(document: Record<string, unknown>): Record<string, unknown> {
  const sessions = isRecord(document.sessions)
    ? Object.fromEntries(Object.entries(document.sessions).map(([projectId, value]) => {
        if (!isRecord(value)) return [projectId, value];
        return [projectId, {
          ...value,
          agentIdentity: legacyOpenAiAgentIdentity(),
          resumable: true,
        }];
      }))
    : document.sessions;
  return { ...document, schemaVersion: STORAGE_SCHEMA_VERSION, sessions };
}

function normalizeLegacySessionIdentities(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.sessions)) return value;
  const legacyIdentity = legacyOpenAiAgentIdentity();
  const sessions = Object.fromEntries(Object.entries(value.sessions).map(([projectId, session]) => {
    if (!isRecord(session) || session.agentIdentity !== undefined) return [projectId, session];
    return [projectId, { ...session, agentIdentity: legacyIdentity, resumable: true }];
  }));
  return { ...value, sessions };
}

function normalizeLegacyActors(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const activeProjects = isRecord(value.activeProjects)
    ? Object.fromEntries(Object.entries(value.activeProjects).flatMap(([key, record]): Array<[string, unknown]> => {
        const actorId = parseActorId(key) ?? (/^\d+$/u.test(key) ? telegramActorId(Number(key)) : undefined);
        return actorId === undefined || !isRecord(record)
          ? [[key, record] as [string, unknown]]
          : [[actorId, { ...record, actorId }] as [string, unknown], ...(key === actorId ? [] : [[key, { ...record, actorId }] as [string, unknown]])];
      }))
    : value.activeProjects;
  const confirmations = Array.isArray(value.confirmations)
    ? value.confirmations.map((record) => isRecord(record) && record.actorId === undefined && typeof record.userId === "number"
      ? { ...record, actorId: telegramActorId(record.userId) } : record)
    : value.confirmations;
  const sessions = isRecord(value.sessions)
    ? Object.fromEntries(Object.entries(value.sessions).map(([projectId, session]) => {
        if (!isRecord(session) || !isRecord(session.pendingQuestion)) return [projectId, session];
        const question = session.pendingQuestion;
        return typeof question.userId === "number" && question.actorId === undefined
          ? [projectId, { ...session, pendingQuestion: { ...question, actorId: telegramActorId(question.userId) } }]
          : [projectId, session];
      }))
    : value.sessions;
  return { ...value, activeProjects, confirmations, sessions };
}

function assertTestSummary(value: unknown): void {
  assert(isRecord(value), "invalid test summary");
  assert(new Set(["not_run", "passed", "failed", "stopped"]).has(value.status as string), "invalid test status");
  if (value.durationMs !== undefined) assertNonNegativeInteger(value.durationMs, "invalid test duration");
  if (value.exitCode !== undefined && value.exitCode !== null) assertInteger(value.exitCode, "invalid test exit code");
}

function assertGitSummary(value: unknown): void {
  assert(isRecord(value), "invalid Git summary");
  assert(value.branchBefore === null || typeof value.branchBefore === "string", "invalid initial branch");
  assert(value.branchAfter === null || typeof value.branchAfter === "string", "invalid final branch");
  assert(typeof value.cleanBefore === "boolean" && typeof value.cleanAfter === "boolean", "invalid Git cleanliness");
  for (const field of ["changedFiles", "additions", "deletions", "observedDuringTaskFiles"] as const) {
    assertNonNegativeInteger(value[field], `invalid Git ${field}`);
  }
}

function assertNonNegativeInteger(value: unknown, message: string): void {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, message);
}

function assertInteger(value: unknown, message: string): void {
  assert(typeof value === "number" && Number.isSafeInteger(value), message);
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
