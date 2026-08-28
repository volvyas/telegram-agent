import type { AgentSession } from "../domain/AgentSession.js";
import type { ProjectConfig } from "../config/ProjectConfig.js";
import type { ProjectManager } from "../projects/ProjectManager.js";
import type { AgentEvent } from "./AgentEvent.js";
import { AgentStateMachine } from "./AgentStateMachine.js";
import type { AgentState } from "./AgentState.js";
import type { CodingAgent } from "./CodingAgent.js";

export interface AgentProjectRegistry {
  require(projectId: string): ProjectConfig;
}

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

export interface AgentManagerOptions {
  readonly onEvent?: AgentEventListener;
  readonly clock?: () => Date;
}

export interface AgentStatus {
  readonly projectId: string;
  readonly state: AgentState;
  readonly active: boolean;
  readonly runId?: string;
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
  runId?: string;
}

type AgentSessionPatch = Partial<
  Omit<AgentSession, "activeRunId" | "lastEvent">
> & {
  readonly activeRunId?: string | undefined;
  readonly lastEvent?: AgentEvent | undefined;
};

export class AgentManager {
  readonly #agent: CodingAgent;
  readonly #projects: AgentProjectRegistry;
  readonly #clock: () => Date;
  readonly #onEvent: AgentEventListener | undefined;
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
  }

  /** Starts and consumes one complete agent turn. */
  public async startTask(projectId: string, prompt: string): Promise<void> {
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
    if (this.#sessions.get(projectId)?.machine.state === "WAITING_FOR_USER") {
      throw new AgentManagerError(
        "SESSION_WAITING_FOR_USER",
        "The project session is waiting for a user response",
        projectId,
      );
    }

    const operation: ActiveOperation = { token: Symbol(projectId) };
    this.#activeOperations.set(projectId, operation);
    const session = this.#beginSession(project);

    try {
      const run = await this.#agent.start({
        projectId,
        workingDirectory: project.path,
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
      await this.#consumeEvents(session, run.runId, run.events);
    } catch (error) {
      if (session.machine.state === "RUNNING") {
        session.machine.transition("turn_failed");
        this.#updateSnapshot(session, { state: session.machine.state });
      }
      if (error instanceof AgentManagerError) {
        throw error;
      }
      throw new AgentManagerError(
        "OPERATION_FAILED",
        "Unable to run the coding agent operation",
        projectId,
        { cause: error },
      );
    } finally {
      const active = this.#activeOperations.get(projectId);
      if (active?.token === operation.token) {
        this.#activeOperations.delete(projectId);
      }
      this.#updateSnapshot(session, { activeRunId: undefined });
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

  public getSession(projectId: string): AgentSession | undefined {
    this.#projects.require(projectId);
    return this.#sessions.get(projectId)?.snapshot;
  }

  #beginSession(project: ProjectConfig): ManagedSession {
    const existing = this.#sessions.get(project.id);
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
      return session;
    }

    const reason = existing.machine.state === "IDLE" ? "task_started" : "continued";
    existing.machine.transition(reason);
    this.#updateSnapshot(existing, {
      state: existing.machine.state,
      startedAt: now,
      lastEvent: undefined,
    });
    return existing;
  }

  async #consumeEvents(
    session: ManagedSession,
    runId: string,
    events: AsyncIterable<AgentEvent>,
  ): Promise<void> {
    let terminal = false;
    for await (const event of events) {
      if (event.projectId !== session.snapshot.projectId || event.runId !== runId) {
        throw new AgentManagerError(
          "EVENT_CONTEXT_MISMATCH",
          "Coding agent emitted an event for another operation",
          session.snapshot.projectId,
        );
      }
      if (terminal) {
        throw new AgentManagerError(
          "EVENT_AFTER_TERMINAL",
          "Coding agent emitted an event after a terminal outcome",
          session.snapshot.projectId,
        );
      }

      terminal = this.#applyEvent(session, event);
      this.#updateSnapshot(session, {
        state: session.machine.state,
        lastEvent: event,
        ...(event.type === "thread_started" ? { threadId: event.threadId } : {}),
      });
      await this.#onEvent?.(event);
    }

    if (!terminal) {
      throw new AgentManagerError(
        "EVENT_STREAM_INCOMPLETE",
        "Coding agent event stream ended without a terminal outcome",
        session.snapshot.projectId,
      );
    }
  }

  #applyEvent(session: ManagedSession, event: AgentEvent): boolean {
    switch (event.type) {
      case "question":
        session.machine.transition("agent_question");
        return true;
      case "completed":
        session.machine.transition("turn_completed");
        return true;
      case "stopped":
        session.machine.transition("stop_requested");
        return true;
      case "error":
        if (event.fatal) {
          session.machine.transition("turn_failed");
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  #updateSnapshot(
    session: ManagedSession,
    patch: AgentSessionPatch,
  ): void {
    const next = { ...session.snapshot } as {
      -readonly [Key in keyof AgentSession]: AgentSession[Key];
    };
    const { activeRunId, lastEvent, ...values } = patch;
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
    session.snapshot = Object.freeze(next);
  }
}
