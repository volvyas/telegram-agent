import type { AgentState } from "../agent/AgentState.js";
import type { TaskGitSummary, TaskStatus, TaskTestSummary } from "../domain/TaskRecord.js";
import type { AgentIdentity } from "../domain/AgentIdentity.js";

export const STORAGE_SCHEMA_VERSION = 2 as const;
export const LEGACY_STORAGE_SCHEMA_VERSION = 1 as const;

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
  readonly pendingQuestion?: PersistedPendingQuestion;
  readonly agentIdentity: AgentIdentity;
  readonly resumable?: boolean;
  readonly historicalThreadId?: string;
  readonly resumeDiagnostic?: "AGENT_IDENTITY_CHANGED";
}

export interface PersistedPendingQuestion {
  readonly questionId: string;
  readonly question: string;
  readonly choices: readonly string[];
  readonly userId?: number;
  readonly createdAt: PersistedTimestamp;
}

/** A short-lived, single-use authorization for a potentially dangerous operation. */
export interface Confirmation {
  readonly id: string;
  readonly userId: number;
  readonly projectId: string;
  readonly operation: string;
  readonly createdAt: PersistedTimestamp;
  readonly expiresAt: PersistedTimestamp;
}

export type PersistedTaskStatus = TaskStatus;

export interface PersistedTaskRecord {
  readonly id: string;
  readonly projectId: string;
  readonly promptSummary: string;
  readonly status: PersistedTaskStatus;
  readonly createdAt: PersistedTimestamp;
  readonly startedAt?: PersistedTimestamp;
  readonly finishedAt?: PersistedTimestamp;
  readonly updatedAt: PersistedTimestamp;
  readonly durationMs?: number;
  readonly exitCode?: number | null;
  readonly testSummary?: PersistedTestSummary;
  readonly gitSummary?: PersistedGitSummary;
}

export type PersistedTestSummary = TaskTestSummary;

export type PersistedGitSummary = TaskGitSummary;

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
  readonly confirmations: readonly Confirmation[];
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
    confirmations: [],
  };
}
