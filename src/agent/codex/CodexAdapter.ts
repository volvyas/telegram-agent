import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import { Codex, type ThreadEvent } from "@openai/codex-sdk";

import type {
  AgentMessageOptions,
  AgentResumeOptions,
  AgentStartOptions,
  CodingAgent,
} from "../CodingAgent.js";
import type { AgentEvent } from "../AgentEvent.js";
import type { AgentRun } from "../AgentRun.js";
import {
  CodexEventMapper,
  type CodexDiagnostic,
} from "./CodexEventMapper.js";

const CODEX_ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

export interface SafeCodexThreadOptions {
  readonly threadSource: "codex-remote";
  readonly workingDirectory: string;
  readonly sandboxMode: "workspace-write";
  readonly approvalPolicy: "never";
  readonly networkAccessEnabled: false;
  readonly webSearchMode: "disabled";
  readonly skipGitRepoCheck: false;
  readonly additionalDirectories: readonly string[];
}

export interface CodexThreadPort {
  readonly id: string | null;
  runStreamed(
    input: string,
    options: { readonly signal: AbortSignal },
  ): Promise<{ readonly events: AsyncIterable<ThreadEvent> }>;
}

export interface CodexClientPort {
  startThread(options: SafeCodexThreadOptions): CodexThreadPort;
  resumeThread(threadId: string, options: SafeCodexThreadOptions): CodexThreadPort;
}

export interface CodexAdapterOptions {
  readonly client?: CodexClientPort;
  readonly environment?: NodeJS.ProcessEnv;
  readonly codexHome?: string;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly onDiagnostic?: (diagnostic: CodexDiagnostic) => void;
}

export class CodexAdapterError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAdapterError";
    this.code = code;
  }
}

interface ActiveRun {
  readonly projectId: string;
  readonly controller: AbortController;
}

export class CodexAdapter implements CodingAgent {
  readonly #client: CodexClientPort;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;
  readonly #onDiagnostic: ((diagnostic: CodexDiagnostic) => void) | undefined;
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #threadIds = new Map<string, string>();

  public constructor(options: CodexAdapterOptions = {}) {
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date());
    this.#onDiagnostic = options.onDiagnostic;
    this.#client =
      options.client ??
      new SdkCodexClient(
        createCodexEnvironment(options.environment ?? process.env, options.codexHome),
      );
  }

  public start(options: AgentStartOptions): Promise<AgentRun> {
    validateTurnInput(options.projectId, options.workingDirectory, options.prompt);
    const thread = this.#createThread(options.workingDirectory);
    return this.#startRun(options.projectId, options.prompt, thread);
  }

  public resume(options: AgentResumeOptions): Promise<AgentRun> {
    validateThreadId(options.threadId);
    validateTurnInput(options.projectId, options.workingDirectory, options.prompt);
    this.#threadIds.set(options.projectId, options.threadId);
    const thread = this.#resumeThread(
      options.threadId,
      options.workingDirectory,
    );
    return this.#startRun(options.projectId, options.prompt, thread);
  }

  public send(options: AgentMessageOptions): Promise<AgentRun> {
    validateThreadId(options.threadId);
    validateTurnInput(options.projectId, options.workingDirectory, options.message);
    this.#threadIds.set(options.projectId, options.threadId);
    const thread = this.#resumeThread(
      options.threadId,
      options.workingDirectory,
    );
    return this.#startRun(options.projectId, options.message, thread);
  }

  public stop(runId: string): Promise<boolean> {
    const activeRun = this.#activeRuns.get(runId);
    if (activeRun === undefined) {
      return Promise.resolve(false);
    }

    this.#activeRuns.delete(runId);
    activeRun.controller.abort();
    return Promise.resolve(true);
  }

  public getThreadId(projectId: string): string | undefined {
    return this.#threadIds.get(projectId);
  }

  #createThread(workingDirectory: string): CodexThreadPort {
    try {
      return this.#client.startThread(createThreadOptions(workingDirectory));
    } catch (error) {
      throw new CodexAdapterError(
        "CODEX_THREAD_CREATE_FAILED",
        "Unable to create Codex thread",
        { cause: error },
      );
    }
  }

  #resumeThread(threadId: string, workingDirectory: string): CodexThreadPort {
    try {
      return this.#client.resumeThread(threadId, createThreadOptions(workingDirectory));
    } catch (error) {
      throw new CodexAdapterError(
        "CODEX_THREAD_RESUME_FAILED",
        "Unable to resume Codex thread",
        { cause: error },
      );
    }
  }

  async #startRun(
    projectId: string,
    input: string,
    thread: CodexThreadPort,
  ): Promise<AgentRun> {
    const runId = this.#idFactory();
    if (runId.length === 0 || this.#activeRuns.has(runId)) {
      throw new CodexAdapterError("RUN_ID_INVALID", "Unable to allocate a unique run ID");
    }

    const controller = new AbortController();
    const activeRun = Object.freeze({ projectId, controller });
    this.#activeRuns.set(runId, activeRun);

    let streamedTurn: { readonly events: AsyncIterable<ThreadEvent> };
    try {
      streamedTurn = await thread.runStreamed(input, { signal: controller.signal });
    } catch (error) {
      this.#activeRuns.delete(runId);
      throw new CodexAdapterError(
        "CODEX_START_FAILED",
        "Unable to start Codex turn",
        { cause: error },
      );
    }

    const mapper = new CodexEventMapper({
      runId,
      projectId,
      clock: this.#clock,
    });

    return Object.freeze({
      runId,
      projectId,
      events: this.#mapEvents(streamedTurn.events, mapper, activeRun, runId),
    });
  }

  async *#mapEvents(
    events: AsyncIterable<ThreadEvent>,
    mapper: CodexEventMapper,
    activeRun: ActiveRun,
    runId: string,
  ): AsyncIterable<AgentEvent> {
    let terminalEventSeen = false;
    let reportedDiagnostics = 0;

    try {
      for await (const sdkEvent of events) {
        for (const event of mapper.map(sdkEvent)) {
          if (event.type === "thread_started") {
            this.#threadIds.set(event.projectId, event.threadId);
          }
          terminalEventSeen ||= isTerminalEvent(event);
          yield event;
        }

        const diagnostics = mapper.diagnostics;
        for (const diagnostic of diagnostics.slice(reportedDiagnostics)) {
          this.#onDiagnostic?.(diagnostic);
        }
        reportedDiagnostics = diagnostics.length;
      }
    } catch (error) {
      if (!terminalEventSeen) {
        terminalEventSeen = true;
        if (activeRun.controller.signal.aborted) {
          yield this.#stoppedEvent(runId, activeRun, "user");
        } else {
          yield this.#fatalStreamError(runId, activeRun, error);
        }
      }
    } finally {
      const current = this.#activeRuns.get(runId);
      if (current === activeRun) {
        this.#activeRuns.delete(runId);
      }
    }

    if (!terminalEventSeen) {
      yield activeRun.controller.signal.aborted
        ? this.#stoppedEvent(runId, activeRun, "user")
        : this.#fatalStreamError(runId, activeRun);
    }
  }

  #stoppedEvent(
    runId: string,
    activeRun: ActiveRun,
    reason: "user" | "shutdown" | "timeout",
  ): AgentEvent {
    return {
      type: "stopped",
      runId,
      projectId: activeRun.projectId,
      occurredAt: this.#clock().toISOString(),
      reason,
    };
  }

  #fatalStreamError(runId: string, activeRun: ActiveRun, cause?: unknown): AgentEvent {
    const error = new CodexAdapterError(
      "CODEX_STREAM_FAILED",
      "Codex event stream ended unexpectedly",
      cause === undefined ? undefined : { cause },
    );
    return {
      type: "error",
      runId,
      projectId: activeRun.projectId,
      occurredAt: this.#clock().toISOString(),
      fatal: true,
      message: error.message,
    };
  }
}

class SdkCodexClient implements CodexClientPort {
  readonly #client: Codex;

  public constructor(environment: Readonly<Record<string, string>>) {
    this.#client = new Codex({ env: { ...environment } });
  }

  public startThread(options: SafeCodexThreadOptions): CodexThreadPort {
    return this.#client.startThread(toSdkThreadOptions(options));
  }

  public resumeThread(
    threadId: string,
    options: SafeCodexThreadOptions,
  ): CodexThreadPort {
    return this.#client.resumeThread(threadId, toSdkThreadOptions(options));
  }
}

export function createCodexEnvironment(
  source: NodeJS.ProcessEnv,
  explicitCodexHome?: string,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const name of CODEX_ENVIRONMENT_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  const codexHome = explicitCodexHome ?? source.CODEX_HOME;
  if (codexHome !== undefined) {
    if (!isAbsolute(codexHome)) {
      throw new CodexAdapterError("CODEX_HOME_INVALID", "CODEX_HOME must be absolute");
    }
    environment.CODEX_HOME = codexHome;
  }
  return Object.freeze(environment);
}

function createThreadOptions(workingDirectory: string): SafeCodexThreadOptions {
  return Object.freeze({
    threadSource: "codex-remote",
    workingDirectory,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    skipGitRepoCheck: false,
    additionalDirectories: Object.freeze([]),
  });
}

function toSdkThreadOptions(options: SafeCodexThreadOptions) {
  return {
    ...options,
    additionalDirectories: [...options.additionalDirectories],
  };
}

function validateTurnInput(projectId: string, workingDirectory: string, input: string): void {
  if (projectId.trim().length === 0 || projectId.includes("\0")) {
    throw new CodexAdapterError("PROJECT_ID_INVALID", "Project ID is invalid");
  }
  if (!isAbsolute(workingDirectory) || workingDirectory.includes("\0")) {
    throw new CodexAdapterError(
      "WORKING_DIRECTORY_INVALID",
      "Codex working directory must be absolute",
    );
  }
  if (input.trim().length === 0 || input.includes("\0")) {
    throw new CodexAdapterError("AGENT_INPUT_INVALID", "Codex input is invalid");
  }
}

function validateThreadId(threadId: string): void {
  if (threadId.trim().length === 0 || threadId.includes("\0")) {
    throw new CodexAdapterError("THREAD_ID_INVALID", "Codex thread ID is invalid");
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return (
    event.type === "completed" ||
    event.type === "stopped" ||
    (event.type === "error" && event.fatal)
  );
}
