import type { ProjectConfig } from "../config/ProjectConfig.js";
import type { ModelProviderMap } from "../config/ProjectConfig.js";
import { createAgentIdentity, legacyOpenAiAgentIdentity, type AgentIdentity } from "../domain/AgentIdentity.js";
import type { AgentSession, PendingAgentQuestion } from "../domain/AgentSession.js";
import type { PersistedPendingQuestion, PersistedSessionRecord, Storage } from "../storage/Storage.js";

export interface SessionProjectRegistry {
  require(projectId: string): ProjectConfig;
  modelProviders?(): ModelProviderMap;
}

export interface SessionManagerOptions {
  readonly clock?: () => Date;
}

export type SessionManagerErrorCode =
  | "SESSION_PROJECT_MISMATCH"
  | "SESSION_REPOSITORY_MISMATCH"
  | "SESSION_AGENT_IDENTITY_MISMATCH";

export class SessionManagerError extends Error {
  public readonly code: SessionManagerErrorCode;
  public readonly projectId: string;

  public constructor(
    code: SessionManagerErrorCode,
    message: string,
    projectId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionManagerError";
    this.code = code;
    this.projectId = projectId;
  }
}

/** Persists one isolated Codex thread and agent state per configured project. */
export class SessionManager {
  readonly #storage: Storage;
  readonly #projects: SessionProjectRegistry;
  readonly #clock: () => Date;

  public constructor(
    storage: Storage,
    projects: SessionProjectRegistry,
    options: SessionManagerOptions = {},
  ) {
    this.#storage = storage;
    this.#projects = projects;
    this.#clock = options.clock ?? (() => new Date());
  }

  public async getSession(projectId: string): Promise<AgentSession | undefined> {
    const project = this.#projects.require(projectId);
    let record = (await this.#storage.load()).sessions[project.id];
    if (record === undefined) return undefined;
    this.#assertRecordBelongsToProject(record, project);
    record = await this.#reconcileIdentity(record, project);

    // A process cannot still be running after this manager has been recreated.
    if (record.state === "RUNNING") {
      const reconciledAt = this.#clock().toISOString();
      await this.#storage.update((state) => {
        const current = state.sessions[project.id];
        if (current === undefined) return state;
        this.#assertRecordBelongsToProject(current, project);
        if (current.state !== "RUNNING") return state;
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [project.id]: { ...current, state: "FAILED", updatedAt: reconciledAt },
          },
        };
      });
      record = (await this.#storage.load()).sessions[project.id];
      if (record === undefined) return undefined;
      this.#assertRecordBelongsToProject(record, project);
      record = await this.#reconcileIdentity(record, project);
    }

    return toAgentSession(record);
  }

  /** Reconciles process-local RUNNING sessions after a gateway restart. */
  public async reconcileInterrupted(): Promise<void> {
    const reconciledAt = this.#clock().toISOString();
    await this.#storage.update((state) => {
      let changed = false;
      const sessions = Object.fromEntries(Object.entries(state.sessions).map(([projectId, session]) => {
        if (session.state !== "RUNNING") return [projectId, session];
      const project = this.#projects.require(projectId);
      this.#assertRecordBelongsToProject(session, project);
        changed = true;
        return [projectId, { ...session, state: "FAILED" as const, updatedAt: reconciledAt }];
      }));
      return changed ? { ...state, sessions } : state;
    });
    const state = await this.#storage.load();
    for (const [projectId, record] of Object.entries(state.sessions)) {
      const project = this.#projects.require(projectId);
      this.#assertRecordBelongsToProject(record, project);
      await this.#reconcileIdentity(record, project);
    }
  }

  public async saveSession(session: AgentSession): Promise<void> {
    const project = this.#projects.require(session.projectId);
    this.#assertSessionBelongsToProject(session, project);
    const record = toPersistedSession(session, this.#identity(project));

    await this.#storage.update((state) => ({
      ...state,
      sessions: { ...state.sessions, [project.id]: record },
    }));
  }

  async #reconcileIdentity(
    record: PersistedSessionRecord,
    project: ProjectConfig,
  ): Promise<PersistedSessionRecord> {
    const currentIdentity = this.#identity(project);
    if (sameIdentity(record.agentIdentity, currentIdentity)) return record;

    const now = this.#clock().toISOString();
    const { threadId: _threadId, pendingQuestion: _pendingQuestion, ...withoutOldThread } = record;
    const migrated: PersistedSessionRecord = {
      ...withoutOldThread,
      state: "FAILED",
      agentIdentity: currentIdentity,
      resumable: false,
      ...(record.threadId === undefined ? {} : { historicalThreadId: record.threadId }),
      resumeDiagnostic: "AGENT_IDENTITY_CHANGED",
      updatedAt: now,
    };
    await this.#storage.update((state) => ({
      ...state,
      sessions: { ...state.sessions, [project.id]: migrated },
    }));
    return migrated;
  }

  #identity(project: ProjectConfig): AgentIdentity {
    return createAgentIdentity(project, this.#projects.modelProviders?.());
  }

  #assertSessionBelongsToProject(session: AgentSession, project: ProjectConfig): void {
    if (session.projectId !== project.id) {
      throw new SessionManagerError(
        "SESSION_PROJECT_MISMATCH",
        "Session belongs to another project",
        project.id,
      );
    }
    if (session.projectPath !== project.path) {
      throw new SessionManagerError(
        "SESSION_REPOSITORY_MISMATCH",
        "Session repository does not match the configured project repository",
        project.id,
      );
    }
  }

  #assertRecordBelongsToProject(
    record: PersistedSessionRecord,
    project: ProjectConfig,
  ): void {
    if (record.projectId !== project.id) {
      throw new SessionManagerError(
        "SESSION_PROJECT_MISMATCH",
        "Persisted session belongs to another project",
        project.id,
      );
    }
    if (record.projectPath !== project.path) {
      throw new SessionManagerError(
        "SESSION_REPOSITORY_MISMATCH",
        "Persisted session repository does not match the configured project repository",
        project.id,
      );
    }
  }
}

function toPersistedSession(session: AgentSession, fallbackIdentity: AgentIdentity): PersistedSessionRecord {
  return {
    projectId: session.projectId,
    projectPath: session.projectPath,
    state: session.state,
    ...(session.threadId === undefined ? {} : { threadId: session.threadId }),
    ...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
    ...(session.pendingQuestion === undefined
      ? {}
      : { pendingQuestion: toPersistedQuestion(session.pendingQuestion) }),
    updatedAt: session.updatedAt,
    agentIdentity: session.agentIdentity ?? fallbackIdentity,
    ...(session.resumable === undefined ? {} : { resumable: session.resumable }),
    ...(session.historicalThreadId === undefined ? {} : { historicalThreadId: session.historicalThreadId }),
    ...(session.resumeDiagnostic === undefined ? {} : { resumeDiagnostic: session.resumeDiagnostic }),
  };
}

function toAgentSession(record: PersistedSessionRecord): AgentSession {
  return Object.freeze({
    projectId: record.projectId,
    projectPath: record.projectPath,
    state: record.state,
    ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.pendingQuestion === undefined
      ? {}
      : { pendingQuestion: toAgentQuestion(record.pendingQuestion) }),
    updatedAt: record.updatedAt,
    agentIdentity: record.agentIdentity ?? legacyOpenAiAgentIdentity(),
    ...(record.resumable === undefined ? {} : { resumable: record.resumable }),
    ...(record.historicalThreadId === undefined ? {} : { historicalThreadId: record.historicalThreadId }),
    ...(record.resumeDiagnostic === undefined ? {} : { resumeDiagnostic: record.resumeDiagnostic }),
  });
}

function sameIdentity(left: AgentIdentity | undefined, right: AgentIdentity): boolean {
  if (left === undefined) return sameIdentity(legacyOpenAiAgentIdentity(), right);
  return left.adapterKind === right.adapterKind &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.providerFingerprint === right.providerFingerprint;
}

function toPersistedQuestion(question: PendingAgentQuestion): PersistedPendingQuestion {
  return {
    questionId: question.questionId,
    question: question.question,
    choices: [...question.choices],
    ...(question.userId === undefined ? {} : { userId: question.userId }),
    createdAt: question.createdAt,
  };
}

function toAgentQuestion(question: PersistedPendingQuestion): PendingAgentQuestion {
  return Object.freeze({
    questionId: question.questionId,
    question: question.question,
    choices: Object.freeze([...question.choices]),
    ...(question.userId === undefined ? {} : { userId: question.userId }),
    createdAt: question.createdAt,
  });
}
