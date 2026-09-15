import type { AgentState } from "../agent/AgentState.js";

export const STORAGE_SCHEMA_VERSION = 1 as const;

/** ISO 8601 UTC timestamp produced by Date#toISOString. */
export type PersistedTimestamp = string;

export interface ActiveProjectRecord {
  readonly projectId: string;
  readonly updatedAt: PersistedTimestamp;
}

export interface PersistedSessionRecord {
  readonly projectId: string;
  readonly projectPath: string;
  readonly state: AgentState;
  readonly threadId?: string;
  readonly startedAt?: PersistedTimestamp;
  readonly updatedAt: PersistedTimestamp;
}

export type PersistedTaskStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "completed"
  | "failed"
  | "stopped";

export interface PersistedTaskRecord {
  readonly id: string;
  readonly projectId: string;
  readonly promptSummary: string;
  readonly status: PersistedTaskStatus;
  readonly createdAt: PersistedTimestamp;
  readonly updatedAt: PersistedTimestamp;
}

export interface PersistedSequenceRecord {
  /** The positive numeric suffix to reserve for the next task. */
  readonly nextTaskNumber: number;
}

/** Complete, versioned gateway-owned state. Configuration remains external. */
export interface PersistedState {
  readonly schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  readonly activeProjects: Readonly<Record<string, ActiveProjectRecord>>;
  readonly sessions: Readonly<Record<string, PersistedSessionRecord>>;
  readonly tasks: readonly PersistedTaskRecord[];
  readonly sequence: PersistedSequenceRecord;
}

export type StorageUpdate = (state: PersistedState) => PersistedState;

export type StorageErrorCode =
  | "STORAGE_CLOSED"
  | "STORAGE_DAMAGED"
  | "STORAGE_UNSUPPORTED_VERSION"
  | "STORAGE_READ_FAILED"
  | "STORAGE_WRITE_FAILED";

export class StorageError extends Error {
  public readonly code: StorageErrorCode;

  public constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

/** Persistence boundary used by application/domain services. */
export interface Storage {
  load(): Promise<PersistedState>;
  update(mutator: StorageUpdate): Promise<void>;
  close(): Promise<void>;
}

export function createEmptyPersistedState(): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    activeProjects: {},
    sessions: {},
    tasks: [],
    sequence: { nextTaskNumber: 1 },
  };
}
