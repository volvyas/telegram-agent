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
import type { PersistedTaskRecord, PersistedTaskStatus } from "../storage/Storage.js";
import { summarizeGit, summarizePrompt, type FinishTaskInput } from "../tasks/TaskManager.js";
import { DEFAULT_OPERATION_POLICY, type OperationPolicy } from "../policy/OperationPolicy.js";
import { telegramActorId, type ActorId } from "../domain/Actor.js";

export interface AgentProjectRegistry {
  require(projectId: string): ProjectConfig;
}

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;
export type AgentResolver = (projectId: string) => CodingAgent;

export interface AgentSessionStore {
  getSession(projectId: string): Promise<AgentSession | undefined>;
  saveSession(session: AgentSession): Promise<void>;
}

export interface AgentManagerOptions {
  readonly onEvent?: AgentEventListener;
  readonly clock?: () => Date;
  readonly sessionStore?: AgentSessionStore;
  readonly gitService?: GitStatusReader;
  readonly taskStore?: AgentTaskStore;
}

export interface AgentTaskStore {
  start(projectId: string, prompt: string): Promise<PersistedTaskRecord>;
  resumeWaiting(projectId: string): Promise<PersistedTaskRecord | undefined>;
  finish(taskId: string, input: FinishTaskInput): Promise<PersistedTaskRecord>;
  fail(taskId: string, exitCode?: number | null): Promise<PersistedTaskRecord>;
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
  Omit<AgentSession, "activeRunId" | "lastEvent" | "pendingQuestion" | "resumeDiagnostic">
> & {
  readonly activeRunId?: string | undefined;
  readonly lastEvent?: AgentEvent | undefined;
  readonly pendingQuestion?: PendingAgentQuestion | undefined;
  readonly resumeDiagnostic?: "AGENT_IDENTITY_CHANGED" | undefined;
};

export class AgentManager implements ProjectOperationCoordinator, ProjectOperationStopper {
  readonly #agent: AgentResolver;
  readonly #projects: AgentProjectRegistry;
  readonly #clock: () => Date;
  readonly #onEvent: AgentEventListener | undefined;
  readonly #sessionStore: AgentSessionStore | undefined;
  readonly #gitService: GitStatusReader;
  readonly #taskStore: AgentTaskStore | undefined;
  readonly #policy: OperationPolicy;
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #activeOperations = new Map<string, ActiveOperation>();
  #nextTransientTaskNumber = 1;

  public constructor(
    agent: CodingAgent | AgentResolver,
    projects: ProjectManager | AgentProjectRegistry,
    options: AgentManagerOptions = {},
  ) {
    this.#agent = typeof agent === "function" ? agent : () => agent;
    this.#projects = projects;
    this.#clock = options.clock ?? (() => new Date());
    this.#onEvent = options.onEvent;
    this.#sessionStore = options.sessionStore;
    this.#gitService = options.gitService ?? new GitService();
    this.#taskStore = options.taskStore;
    this.#policy = DEFAULT_OPERATION_POLICY;
  }

  /** Starts and consumes one complete agent turn. */
  public async startTask(projectId: string, prompt: string, userId?: number, actorId?: ActorId): Promise<TaskRecord> {
    const project = this.#projects.require(projectId);
    const agent = this.#agent(projectId);
    if (this.#policy.evaluate(project, "task").kind === "forbidden") {
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
    let history: PersistedTaskRecord | undefined;

    try {
      history = await this.#taskStore?.start(projectId, prompt);
      const before = await this.#captureGitSnapshot(project.path);
      const prepared = await this.#beginSession(project);
      session = prepared.session;
      operation.session = session;
      await this.#persistSession(session);
      const agentPrompt = prepareAgentPrompt(prompt);
      const run = prepared.threadId === undefined
        ? await agent.start({
            projectId,
            workingDirectory: project.path,
            prompt: agentPrompt,
          })
        : await agent.resume({
            projectId,
            workingDirectory: project.path,
            threadId: prepared.threadId,
            prompt: agentPrompt,
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
      await this.#emitResumeDiagnostic(session, run.runId);
      if (operation.stopRequested) await agent.stop(run.runId);
      const terminalEvent = await this.#consumeEvents(
        session,
        run.runId,
        run.events,
        operation.controller.signal,
        userId,
        actorId,
      );
      // A completed agent turn must not be reported as failed because a
      // best-effort post-run Git snapshot could not be collected.
      let after = before;
      try {
        after = await this.#captureGitSnapshot(project.path);
      } catch {
        // Preserve the pre-run snapshot; the task result remains authoritative.
      }
      const git = createGitTaskSnapshot(before, after);
      history = await this.#finishHistory(history, session.machine.state, git);
      return this.#createTaskRecord(
        history,
        prompt,
        projectId,
        run.runId,
        startedAt,
        terminalEvent,
        git,
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
      if (history !== undefined && history.status === "running") {
        try {
          history = await this.#taskStore?.fail(history.id) ?? history;
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
    const agent = this.#agent(projectId);
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
      if (operation.runId !== undefined) await agent.stop(operation.runId);
    }
    return true;
  }

  /** Sends an answer only to the pending question in the same project thread. */
  public async answerQuestion(projectId: string, questionId: string, answer: string, userId?: number, actorId?: ActorId): Promise<TaskRecord> {
    const project = this.#projects.require(projectId);
    const agent = this.#agent(projectId);
    if (this.#activeOperations.has(projectId)) {
      throw new AgentManagerError("OPERATION_ACTIVE", "An operation is already active for this project", projectId);
    }
    const operation = createActiveOperation(projectId, "agent");
    this.#activeOperations.set(projectId, operation);
    let session: ManagedSession | undefined;
    const startedAt = this.#clock().toISOString();
    let history: PersistedTaskRecord | undefined;
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
      history = await this.#taskStore?.resumeWaiting(projectId);
      const before = await this.#captureGitSnapshot(project.path);
      session.machine.transition("user_answered");
      this.#updateSnapshot(session, { state: session.machine.state, activeRunId: undefined, lastEvent: undefined, pendingQuestion: undefined });
      await this.#persistSession(session);
      const run = await agent.send({ projectId, workingDirectory: project.path, threadId, message: answer });
      if (run.projectId !== projectId) throw new AgentManagerError("RUN_PROJECT_MISMATCH", "Coding agent returned a run for another project", projectId);
      operation.runId = run.runId;
      this.#updateSnapshot(session, { activeRunId: run.runId });
      const terminalEvent = await this.#consumeEvents(
        session,
        run.runId,
        run.events,
        operation.controller.signal,
        userId,
        actorId,
      );
      const after = await this.#captureGitSnapshot(project.path);
      const git = createGitTaskSnapshot(before, after);
      history = await this.#finishHistory(history, session.machine.state, git);
      return this.#createTaskRecord(
        history,
        "User answer",
        projectId,
        run.runId,
        startedAt,
        terminalEvent,
        git,
        session.machine.state,
      );
    } catch (error) {
      let operationError = error;
      if (session?.machine.state === "RUNNING") {
        session.machine.transition("turn_failed");
        this.#updateSnapshot(session, { state: session.machine.state });
        try { await this.#persistSession(session); } catch (persistenceError) { operationError = persistenceError; }
      }
      if (history !== undefined && history.status === "running") {
        try { history = await this.#taskStore?.fail(history.id) ?? history; } catch (persistenceError) { operationError = persistenceError; }
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

    // A failed stream is not a safe continuation point. Start a fresh thread
    // so a transient/invalid Codex process cannot make every later task fail.
    const threadId = existing.machine.state === "FAILED" || existing.snapshot.resumable === false
      ? undefined
      : existing.snapshot.threadId;
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

  async #emitResumeDiagnostic(session: ManagedSession, runId: string): Promise<void> {
    if (session.snapshot.resumeDiagnostic !== "AGENT_IDENTITY_CHANGED") return;
    const event: AgentEvent = {
      type: "warning",
      projectId: session.snapshot.projectId,
      runId,
      occurredAt: this.#clock().toISOString(),
      message: "Agent configuration changed; started a new thread instead of resuming the previous session.",
    };
    this.#updateSnapshot(session, { lastEvent: event, resumeDiagnostic: undefined });
    await this.#persistSession(session);
    await this.#onEvent?.(event);
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
    signal: AbortSignal,
    userId?: number,
    actorId?: ActorId,
  ): Promise<AgentTerminalEvent | AgentQuestionEvent> {
    if (signal.aborted) return this.#recordStoppedEvent(session, runId);
    let terminalEvent: AgentTerminalEvent | AgentQuestionEvent | undefined;
    for await (const event of events) {
      if (signal.aborted) return this.#recordStoppedEvent(session, runId);
      if (event.projectId !== session.snapshot.projectId || event.runId !== runId) {
        throw new AgentManagerError(
          "EVENT_CONTEXT_MISMATCH",
          "Coding agent emitted an event for another operation",
          session.snapshot.projectId,
        );
      }
      if (terminalEvent !== undefined) {
        // The Codex stream can emit bookkeeping or duplicate terminal items
        // after the first terminal outcome. The first terminal outcome is
        // authoritative and later items must not invalidate the turn.
        continue;
      }

      const ownerActorId = actorId ?? (userId === undefined ? undefined : telegramActorId(userId));
      const ownedEvent: AgentEvent = event.ownerActorId === undefined && ownerActorId !== undefined
        ? { ...event, ownerActorId, originActorId: ownerActorId }
        : event;
      terminalEvent = this.#applyEvent(session, ownedEvent) ?? terminalEvent;
      this.#updateSnapshot(session, {
        state: session.machine.state,
        lastEvent: ownedEvent,
        ...(ownedEvent.type === "thread_started" ? { threadId: ownedEvent.threadId } : {}),
        ...(ownedEvent.type === "question" ? { pendingQuestion: toPendingQuestion(ownedEvent, userId) } : {}),
      });
      await this.#persistSession(session);
      await this.#onEvent?.(ownedEvent);
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

  async #recordStoppedEvent(
    session: ManagedSession,
    runId: string,
  ): Promise<AgentTerminalEvent> {
    const event: AgentTerminalEvent = {
      type: "stopped",
      runId,
      projectId: session.snapshot.projectId,
      occurredAt: this.#clock().toISOString(),
      reason: "user",
    };
    this.#applyEvent(session, event);
    this.#updateSnapshot(session, {
      state: session.machine.state,
      lastEvent: event,
      pendingQuestion: undefined,
    });
    await this.#persistSession(session);
    await this.#onEvent?.(event);
    return event;
  }

  async #captureGitSnapshot(repositoryPath: string): Promise<GitSnapshot> {
    const status = await this.#gitService.getStatus(repositoryPath);
    return createGitSnapshot(status, this.#clock().toISOString());
  }

  #createTaskRecord(
    history: PersistedTaskRecord | undefined,
    prompt: string,
    projectId: string,
    runId: string,
    startedAt: string,
    terminalEvent: AgentTerminalEvent | AgentQuestionEvent,
    git: ReturnType<typeof createGitTaskSnapshot>,
    state: AgentState,
  ): TaskRecord {
    const finishedAt = history?.finishedAt ?? this.#clock().toISOString();
    const effectiveStartedAt = history?.startedAt ?? startedAt;
    const status = taskStatus(state);
    const gitSummary = summarizeGit(git);
    return Object.freeze({
      id: history?.id ?? this.#transientTaskId(),
      projectId,
      promptSummary: history?.promptSummary ?? summarizePrompt(prompt),
      runId,
      state,
      status,
      startedAt: effectiveStartedAt,
      finishedAt,
      durationMs: history?.durationMs ?? Math.max(0, new Date(finishedAt).valueOf() - new Date(effectiveStartedAt).valueOf()),
      exitCode: history?.exitCode ?? null,
      testSummary: history?.testSummary ?? { status: "not_run" as const },
      gitSummary: history?.gitSummary ?? gitSummary,
      terminalEvent,
      git,
    });
  }

  #transientTaskId(): string {
    const id = `TASK-${String(this.#nextTransientTaskNumber).padStart(4, "0")}`;
    this.#nextTransientTaskNumber += 1;
    return id;
  }

  async #finishHistory(
    history: PersistedTaskRecord | undefined,
    state: AgentState,
    git: ReturnType<typeof createGitTaskSnapshot>,
  ): Promise<PersistedTaskRecord | undefined> {
    if (history === undefined || this.#taskStore === undefined) return history;
    return this.#taskStore.finish(history.id, {
      status: taskStatus(state),
      exitCode: null,
      git,
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
      case "issue_proposal":
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

function taskStatus(state: AgentState): Exclude<PersistedTaskStatus, "pending" | "running"> {
  switch (state) {
    case "WAITING_FOR_USER": return "waiting_for_user";
    case "COMPLETED": return "completed";
    case "STOPPED": return "stopped";
    case "FAILED":
    case "IDLE":
    case "RUNNING": return "failed";
  }
}

function prepareAgentPrompt(prompt: string): string {
  if (!looksLikeIssueCreationRequest(prompt)) return prompt;
  return [
    "Gateway protocol for this request:",
    "The user is asking for a bug tracker issue proposal.",
    "Investigate the defect locally, but do not create an issue yourself.",
    "Do not use a GitHub API, GitHub CLI, connector, git push, or any network mutation.",
    "Never inspect .git/config or any credential-bearing Git metadata; never print, copy, or include credentials, authenticated remote URLs, or secrets.",
    "When finished, your final agent message must be only this JSON object, with no Markdown fences or extra text:",
    '{"kind":"issue_creation","provider":"github","draft":{"summary":"...","description":"..."}}',
    "The summary must be concise and contain no local paths, secrets, or raw exception payloads.",
    "The description must contain Markdown headings exactly for Context, Observed behavior, Evidence or reproduction, Expected behavior, and Acceptance criteria.",
    "Mark unverified assumptions explicitly and do not invent observations.",
    "If the defect cannot be established from local evidence, return a normal explanation instead of fabricating a proposal.",
    "",
    "User request:",
    prompt,
  ].join("\n");
}

function looksLikeIssueCreationRequest(prompt: string): boolean {
  return /\b(?:create|open|file|submit|report|log)\b[\s\S]{0,80}\b(?:issue|bug)\b|\b(?:issue|bug)\b[\s\S]{0,80}\b(?:create|open|file|submit|report|log)\b/iu.test(prompt);
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
