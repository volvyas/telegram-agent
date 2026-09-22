import type { AgentSession, PendingAgentQuestion } from "../domain/AgentSession.js";
import type { ProjectConfig } from "../config/ProjectConfig.js";
import {
  createGitSnapshot,
  createGitTaskSnapshot,
  type GitSnapshot,
} from "../domain/GitSnapshot.js";
import type { TaskRecord } from "../domain/TaskRecord.js";
import { GitService, type GitStatus } from "../git/GitService.js";
import type { ProjectManager } from "../projects/ProjectManager.js";
import type { AgentEvent, AgentQuestionEvent, AgentTerminalEvent } from "./AgentEvent.js";
import { AgentStateMachine } from "./AgentStateMachine.js";
import type { AgentState } from "./AgentState.js";
import type { CodingAgent } from "./CodingAgent.js";

export interface AgentProjectRegistry {
  require(projectId: string): ProjectConfig;
}

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

export interface AgentSessionStore {
  getSession(projectId: string): Promise<AgentSession | undefined>;
  saveSession(session: AgentSession): Promise<void>;
}

export interface AgentManagerOptions {
  readonly onEvent?: AgentEventListener;
  readonly clock?: () => Date;
  readonly sessionStore?: AgentSessionStore;
  readonly gitService?: GitStatusReader;
}

export interface GitStatusReader {
  getStatus(repositoryPath: string): Promise<GitStatus>;
}

export interface AgentStatus {
  readonly projectId: string;
  readonly state: AgentState;
  readonly active: boolean;
  readonly runId?: string;
}

/** Coordinates work that must not overlap with an active coding-agent turn. */
export interface ProjectOperationCoordinator {
  runExclusive<T>(projectId: string, operation: string, action: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export interface ProjectOperationStopper {
  stop(projectId: string): Promise<boolean>;
}

export class AgentManagerError extends Error {
  public readonly code: string;
  public readonly projectId: string;

  public constructor(
    code: string,
    message: string,
    projectId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentManagerError";
    this.code = code;
    this.projectId = projectId;
  }
}

interface ManagedSession {
  readonly machine: AgentStateMachine;
  snapshot: AgentSession;
}

interface ActiveOperation {
  readonly token: symbol;
  readonly finished: Promise<void>;
  readonly finish: () => void;
  readonly kind: "agent" | "external";
  readonly controller: AbortController;
  stopRequested: boolean;
  runId?: string;
  session?: ManagedSession;
}

type AgentSessionPatch = Partial<
  Omit<AgentSession, "activeRunId" | "lastEvent" | "pendingQuestion">
> & {
  readonly activeRunId?: string | undefined;
  readonly lastEvent?: AgentEvent | undefined;
  readonly pendingQuestion?: PendingAgentQuestion | undefined;
};

export class AgentManager implements ProjectOperationCoordinator, ProjectOperationStopper {
  readonly #agent: CodingAgent;
  readonly #projects: AgentProjectRegistry;
  readonly #clock: () => Date;
  readonly #onEvent: AgentEventListener | undefined;
  readonly #sessionStore: AgentSessionStore | undefined;
  readonly #gitService: GitStatusReader;
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #activeOperations = new Map<string, ActiveOperation>();

  public constructor(
    agent: CodingAgent,
    projects: ProjectManager | AgentProjectRegistry,
    options: AgentManagerOptions = {},
  ) {
    this.#agent = agent;
    this.#projects = projects;
    this.#clock = options.clock ?? (() => new Date());
    this.#onEvent = options.onEvent;
    this.#sessionStore = options.sessionStore;
    this.#gitService = options.gitService ?? new GitService();
  }

  /** Starts and consumes one complete agent turn. */
  public async startTask(projectId: string, prompt: string, userId?: number): Promise<TaskRecord> {
    const project = this.#projects.require(projectId);
    if (!project.allowedOperations.has("task")) {
      throw new AgentManagerError(
        "TASK_NOT_ALLOWED",
        "Tasks are not allowed for this project",
        projectId,
      );
    }
    if (this.#activeOperations.has(projectId)) {
      throw new AgentManagerError(
        "OPERATION_ACTIVE",
        "An operation is already active for this project",
        projectId,
      );
    }
    const operation = createActiveOperation(projectId, "agent");
    this.#activeOperations.set(projectId, operation);
    let session: ManagedSession | undefined;
    const startedAt = this.#clock().toISOString();

    try {
      const before = await this.#captureGitSnapshot(project.path);
      const prepared = await this.#beginSession(project);
      session = prepared.session;
      operation.session = session;
      await this.#persistSession(session);
      const run = prepared.threadId === undefined
        ? await this.#agent.start({
            projectId,
            workingDirectory: project.path,
            prompt,
          })
        : await this.#agent.resume({
            projectId,
            workingDirectory: project.path,
            threadId: prepared.threadId,
            prompt,
          });
      if (run.projectId !== projectId) {
        throw new AgentManagerError(
          "RUN_PROJECT_MISMATCH",
          "Coding agent returned a run for another project",
          projectId,
        );
      }

      operation.runId = run.runId;
      this.#updateSnapshot(session, { activeRunId: run.runId });
      if (operation.stopRequested) await this.#agent.stop(run.runId);
      const terminalEvent = await this.#consumeEvents(session, run.runId, run.events, userId);
      const after = await this.#captureGitSnapshot(project.path);
      return this.#createTaskRecord(
        projectId,
        run.runId,
        startedAt,
        terminalEvent,
        before,
        after,
        session.machine.state,
      );
    } catch (error) {
      let operationError = error;
      if (session?.machine.state === "RUNNING") {
        session.machine.transition("turn_failed");
        this.#updateSnapshot(session, { state: session.machine.state });
        try {
          await this.#persistSession(session);
        } catch (persistenceError) {
          operationError = persistenceError;
        }
      }
      if (operationError instanceof AgentManagerError) {
        throw operationError;
      }
      throw new AgentManagerError(
        "OPERATION_FAILED",
        "Unable to run the coding agent operation",
        projectId,
        { cause: operationError },
      );
    } finally {
      const active = this.#activeOperations.get(projectId);
      if (active?.token === operation.token) {
        this.#activeOperations.delete(projectId);
      }
      if (session !== undefined) {
        this.#updateSnapshot(session, { activeRunId: undefined });
      }
      operation.finish();
    }
  }

  public getStatus(projectId: string): AgentStatus {
    const project = this.#projects.require(projectId);
    const session = this.#sessions.get(project.id);
    const active = this.#activeOperations.get(project.id);
    return Object.freeze({
      projectId: project.id,
      state: session?.machine.state ?? "IDLE",
      active: active !== undefined,
      ...(active?.runId === undefined ? {} : { runId: active.runId }),
    });
  }

  /**
   * Reserves a project while a non-agent operation is running.  This shares the
   * same reservation map as agent turns, so a test cannot race a task.
   */
  public async runExclusive<T>(
    projectId: string,
    operationName: string,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.#projects.require(projectId);
    if (this.#activeOperations.has(projectId)) {
      throw new AgentManagerError(
        "OPERATION_ACTIVE",
        "An operation is already active for this project",
        projectId,
      );
    }

    const operation = createActiveOperation(projectId, "external");
    this.#activeOperations.set(projectId, operation);
    try {
      return await action(operation.controller.signal);
    } catch (error) {
      if (error instanceof AgentManagerError) throw error;
      throw new AgentManagerError(
        "OPERATION_FAILED",
        `Unable to run ${operationName} operation`,
        projectId,
        { cause: error },
      );
    } finally {
      if (this.#activeOperations.get(projectId)?.token === operation.token) {
        this.#activeOperations.delete(projectId);
      }
      operation.finish();
    }
  }

  /** Requests cancellation for the active task or configured command. */
  public async stop(projectId: string): Promise<boolean> {
    this.#projects.require(projectId);
    const operation = this.#activeOperations.get(projectId);
    if (operation === undefined) return false;

    operation.stopRequested = true;
    operation.controller.abort();
    if (operation.kind === "agent") {
      const session = operation.session;
      if (session?.machine.can("stop_requested")) {
        session.machine.transition("stop_requested");
        this.#updateSnapshot(session, { state: session.machine.state });
        await this.#persistSession(session);
      }
      if (operation.runId !== undefined) await this.#agent.stop(operation.runId);
    }
    return true;
  }

  /** Sends an answer only to the pending question in the same project thread. */
  public async answerQuestion(projectId: string, questionId: string, answer: string, userId?: number): Promise<TaskRecord> {
    const project = this.#projects.require(projectId);
    if (this.#activeOperations.has(projectId)) {
      throw new AgentManagerError("OPERATION_ACTIVE", "An operation is already active for this project", projectId);
    }
    const operation = createActiveOperation(projectId, "agent");
    this.#activeOperations.set(projectId, operation);
    let session: ManagedSession | undefined;
    const startedAt = this.#clock().toISOString();
    try {
      session = await this.#getWaitingSession(project);
      const pending = session.snapshot.pendingQuestion;
      if (pending?.questionId !== questionId) {
        throw new AgentManagerError("QUESTION_STALE", "The question is no longer pending", projectId);
      }
      if (pending.userId !== undefined && pending.userId !== userId) {
        throw new AgentManagerError("QUESTION_USER_MISMATCH", "The question belongs to another user", projectId);
      }
      const threadId = session.snapshot.threadId;
      if (threadId === undefined) throw new AgentManagerError("QUESTION_THREAD_MISSING", "The question has no resumable thread", projectId);
      const before = await this.#captureGitSnapshot(project.path);
      session.machine.transition("user_answered");
      this.#updateSnapshot(session, { state: session.machine.state, activeRunId: undefined, lastEvent: undefined, pendingQuestion: undefined });
      await this.#persistSession(session);
      const run = await this.#agent.send({ projectId, workingDirectory: project.path, threadId, message: answer });
      if (run.projectId !== projectId) throw new AgentManagerError("RUN_PROJECT_MISMATCH", "Coding agent returned a run for another project", projectId);
      operation.runId = run.runId;
      this.#updateSnapshot(session, { activeRunId: run.runId });
      const terminalEvent = await this.#consumeEvents(session, run.runId, run.events, userId);
      const after = await this.#captureGitSnapshot(project.path);
      return this.#createTaskRecord(
        projectId,
        run.runId,
        startedAt,
        terminalEvent,
        before,
        after,
        session.machine.state,
      );
    } catch (error) {
      let operationError = error;
      if (session?.machine.state === "RUNNING") {
        session.machine.transition("turn_failed");
        this.#updateSnapshot(session, { state: session.machine.state });
        try { await this.#persistSession(session); } catch (persistenceError) { operationError = persistenceError; }
      }
      if (operationError instanceof AgentManagerError) throw operationError;
      throw new AgentManagerError("OPERATION_FAILED", "Unable to send the user answer", projectId, { cause: operationError });
    } finally {
      if (this.#activeOperations.get(projectId)?.token === operation.token) this.#activeOperations.delete(projectId);
      if (session !== undefined) this.#updateSnapshot(session, { activeRunId: undefined });
      operation.finish();
    }
  }

  public getSession(projectId: string): AgentSession | undefined {
    this.#projects.require(projectId);
    return this.#sessions.get(projectId)?.snapshot;
  }

  /** Loads a persisted session when continuation is requested after restart. */
  public async getSessionForContinuation(projectId: string): Promise<AgentSession | undefined> {
    this.#projects.require(projectId);
    let session = this.#sessions.get(projectId);
    if (session === undefined) {
      const restored = await this.#sessionStore?.getSession(projectId);
      if (restored !== undefined) {
        session = { machine: new AgentStateMachine(restored.state, this.#clock), snapshot: restored };
        this.#sessions.set(projectId, session);
      }
    }
    return session?.snapshot;
  }

  /** Restores a persisted pending question when this manager was recreated. */
  public async getPendingQuestion(projectId: string): Promise<PendingAgentQuestion | undefined> {
    const project = this.#projects.require(projectId);
    let session = this.#sessions.get(project.id);
    if (session === undefined) {
      const restored = await this.#sessionStore?.getSession(project.id);
      if (restored !== undefined) {
        session = { machine: new AgentStateMachine(restored.state, this.#clock), snapshot: restored };
        this.#sessions.set(project.id, session);
      }
    }
    return session?.snapshot.pendingQuestion;
  }

  /** Requests cancellation for every run currently owned by this manager. */
  public async stopAll(): Promise<void> {
    const projectIds = [...this.#activeOperations.keys()];
    const operations = [...this.#activeOperations.values()];
    await Promise.all(projectIds.map((projectId) => this.stop(projectId)));
    await Promise.all(operations.map((operation) => operation.finished));
  }

  async #beginSession(
    project: ProjectConfig,
  ): Promise<{ readonly session: ManagedSession; readonly threadId?: string }> {
    let existing = this.#sessions.get(project.id);
    if (existing === undefined) {
      const restored = await this.#sessionStore?.getSession(project.id);
      if (restored !== undefined) {
        existing = {
          machine: new AgentStateMachine(restored.state, this.#clock),
          snapshot: restored,
        };
        this.#sessions.set(project.id, existing);
      }
    }
    if (existing?.machine.state === "WAITING_FOR_USER") {
      throw new AgentManagerError(
        "SESSION_WAITING_FOR_USER",
        "The project session is waiting for a user response",
        project.id,
      );
    }

    const now = this.#clock().toISOString();
    if (existing === undefined) {
      const machine = new AgentStateMachine("IDLE", this.#clock);
      machine.transition("task_started");
      const session: ManagedSession = {
        machine,
        snapshot: Object.freeze({
          projectId: project.id,
          projectPath: project.path,
          state: machine.state,
          startedAt: now,
          updatedAt: now,
        }),
      };
      this.#sessions.set(project.id, session);
      return { session };
    }

    const threadId = existing.snapshot.threadId;
    const reason = existing.machine.state === "IDLE" ? "task_started" : "continued";
    existing.machine.transition(reason);
    this.#updateSnapshot(existing, {
      state: existing.machine.state,
      startedAt: now,
      lastEvent: undefined,
    });
    return {
      session: existing,
      ...(threadId === undefined ? {} : { threadId }),
    };
  }

  async #getWaitingSession(project: ProjectConfig): Promise<ManagedSession> {
    let session = this.#sessions.get(project.id);
    if (session === undefined) {
      const restored = await this.#sessionStore?.getSession(project.id);
      if (restored !== undefined) {
        session = { machine: new AgentStateMachine(restored.state, this.#clock), snapshot: restored };
        this.#sessions.set(project.id, session);
      }
    }
    if (session?.machine.state !== "WAITING_FOR_USER") {
      throw new AgentManagerError("QUESTION_NOT_PENDING", "The project is not waiting for an answer", project.id);
    }
    return session;
  }

  async #consumeEvents(
    session: ManagedSession,
    runId: string,
    events: AsyncIterable<AgentEvent>,
    userId?: number,
  ): Promise<AgentTerminalEvent | AgentQuestionEvent> {
    let terminalEvent: AgentTerminalEvent | AgentQuestionEvent | undefined;
    for await (const event of events) {
      if (event.projectId !== session.snapshot.projectId || event.runId !== runId) {
        throw new AgentManagerError(
          "EVENT_CONTEXT_MISMATCH",
          "Coding agent emitted an event for another operation",
          session.snapshot.projectId,
        );
      }
      if (terminalEvent !== undefined) {
        throw new AgentManagerError(
          "EVENT_AFTER_TERMINAL",
          "Coding agent emitted an event after a terminal outcome",
          session.snapshot.projectId,
        );
      }

      terminalEvent = this.#applyEvent(session, event) ?? terminalEvent;
      this.#updateSnapshot(session, {
        state: session.machine.state,
        lastEvent: event,
        ...(event.type === "thread_started" ? { threadId: event.threadId } : {}),
        ...(event.type === "question" ? { pendingQuestion: toPendingQuestion(event, userId) } : {}),
      });
      await this.#persistSession(session);
      await this.#onEvent?.(event);
    }

    if (terminalEvent === undefined) {
      throw new AgentManagerError(
        "EVENT_STREAM_INCOMPLETE",
        "Coding agent event stream ended without a terminal outcome",
        session.snapshot.projectId,
      );
    }
    return terminalEvent;
  }

  async #captureGitSnapshot(repositoryPath: string): Promise<GitSnapshot> {
    const status = await this.#gitService.getStatus(repositoryPath);
    return createGitSnapshot(status, this.#clock().toISOString());
  }

  #createTaskRecord(
    projectId: string,
    runId: string,
    startedAt: string,
    terminalEvent: AgentTerminalEvent | AgentQuestionEvent,
    before: GitSnapshot,
    after: GitSnapshot,
    state: AgentState,
  ): TaskRecord {
    return Object.freeze({
      projectId,
      runId,
      state,
      startedAt,
      finishedAt: this.#clock().toISOString(),
      terminalEvent,
      git: createGitTaskSnapshot(before, after),
    });
  }

  #applyEvent(
    session: ManagedSession,
    event: AgentEvent,
  ): AgentTerminalEvent | AgentQuestionEvent | undefined {
    switch (event.type) {
      case "question":
        if (session.machine.can("agent_question")) session.machine.transition("agent_question");
        return event;
      case "completed":
        if (session.machine.can("turn_completed")) session.machine.transition("turn_completed");
        return event;
      case "stopped":
        if (session.machine.can("stop_requested")) session.machine.transition("stop_requested");
        return event;
      case "error":
        if (event.fatal) {
          if (session.machine.can("turn_failed")) session.machine.transition("turn_failed");
          return event as AgentTerminalEvent;
        }
        return undefined;
      default:
        return undefined;
    }
  }

  #updateSnapshot(
    session: ManagedSession,
    patch: AgentSessionPatch,
  ): void {
    const next = { ...session.snapshot } as {
      -readonly [Key in keyof AgentSession]: AgentSession[Key];
    };
    const { activeRunId, lastEvent, pendingQuestion, ...values } = patch;
    Object.assign(next, values, { updatedAt: this.#clock().toISOString() });

    if (activeRunId === undefined) {
      if ("activeRunId" in patch) {
        delete next.activeRunId;
      }
    } else {
      next.activeRunId = activeRunId;
    }
    if (lastEvent === undefined) {
      if ("lastEvent" in patch) {
        delete next.lastEvent;
      }
    } else {
      next.lastEvent = lastEvent;
    }
    if (pendingQuestion === undefined) {
      if ("pendingQuestion" in patch) delete next.pendingQuestion;
    } else {
      next.pendingQuestion = pendingQuestion;
    }
    session.snapshot = Object.freeze(next);
  }

  async #persistSession(session: ManagedSession): Promise<void> {
    await this.#sessionStore?.saveSession(session.snapshot);
  }
}

function createActiveOperation(projectId: string, kind: ActiveOperation["kind"]): ActiveOperation {
  let finish = (): void => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { token: Symbol(projectId), finished, finish, kind, controller: new AbortController(), stopRequested: false };
}

function toPendingQuestion(event: Extract<AgentEvent, { readonly type: "question" }>, userId?: number): PendingAgentQuestion {
  return Object.freeze({
    questionId: event.questionId,
    question: event.question,
    choices: Object.freeze([...event.choices]),
    ...(userId === undefined ? {} : { userId }),
    createdAt: event.occurredAt,
  });
}
