import {
  allowEnvironment,
  ProcessRunner,
  type ProcessResult,
} from "./ProcessRunner.js";
import type { ProjectCommand, ProjectConfig } from "../config/ProjectConfig.js";
import { DEFAULT_OPERATION_POLICY, type OperationPolicy } from "../policy/OperationPolicy.js";

export type ProjectCommandOperation = "test" | "build" | "run";

export interface ProjectCommandRunnerOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ProjectCommandRunOptions {
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export class ProjectCommandRunnerError extends Error {
  public readonly code:
    | "COMMAND_NOT_CONFIGURED"
    | "OPERATION_NOT_ALLOWED"
    | "PROJECT_BUSY";
  public readonly projectId: string;
  public readonly operation: ProjectCommandOperation;

  public constructor(
    code: ProjectCommandRunnerError["code"],
    message: string,
    projectId: string,
    operation: ProjectCommandOperation,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectCommandRunnerError";
    this.code = code;
    this.projectId = projectId;
    this.operation = operation;
  }
}

/** Runs commands explicitly supplied by trusted project configuration. */
export class ProjectCommandRunner {
  readonly #runner: ProcessRunner;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #defaults: ProjectCommandRunnerOptions;
  readonly #active = new Map<string, AbortController>();
  readonly #policy: OperationPolicy;

  public constructor(
    runner = new ProcessRunner(),
    options: ProjectCommandRunnerOptions = {},
    policy = DEFAULT_OPERATION_POLICY,
  ) {
    this.#runner = runner;
    this.#policy = policy;
    this.#defaults = Object.freeze({ ...options });
    this.#environment = Object.freeze(
      options.environment === undefined
        ? allowEnvironment(process.env, [
            "PATH",
            "LANG",
            "LC_ALL",
            "SYSTEMROOT",
            "WINDIR",
          ])
        : { ...options.environment },
    );
  }

  public isRunning(projectId: string): boolean {
    return this.#active.has(projectId);
  }

  /** Starts one configured command. Telegram/user text is never interpreted here. */
  public async run(
    project: ProjectConfig,
    operation: ProjectCommandOperation,
    options: ProjectCommandRunOptions = {},
  ): Promise<ProcessResult> {
    const command = commandFor(project, operation);
    if (command === undefined) {
      throw new ProjectCommandRunnerError(
        "COMMAND_NOT_CONFIGURED",
        `No ${operation} command is configured for project`,
        project.id,
        operation,
      );
    }
    if (this.#policy.evaluate(project, operation).kind === "forbidden") {
      throw new ProjectCommandRunnerError(
        "OPERATION_NOT_ALLOWED",
        `Operation ${operation} is not allowed for project`,
        project.id,
        operation,
      );
    }
    if (this.#active.has(project.id)) {
      throw new ProjectCommandRunnerError(
        "PROJECT_BUSY",
        "Another project command is already running",
        project.id,
        operation,
      );
    }

    const controller = new AbortController();
    const detach = linkAbortSignal(options.signal, controller);
    this.#active.set(project.id, controller);
    try {
      const timeoutMs = options.timeoutMs ?? this.#defaults.timeoutMs;
      const killGraceMs = options.killGraceMs ?? this.#defaults.killGraceMs;
      const maxOutputBytes = options.maxOutputBytes ?? this.#defaults.maxOutputBytes;
      return await this.#runner.run({
        executable: command.executable,
        args: command.args,
        cwd: project.path,
        env: this.#environment,
        signal: controller.signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(killGraceMs === undefined ? {} : { killGraceMs }),
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
        ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
        ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      });
    } finally {
      detach();
      if (this.#active.get(project.id) === controller) {
        this.#active.delete(project.id);
      }
    }
  }

  /** Alias useful to callers that reserve `run` for the underlying process. */
  public execute(
    project: ProjectConfig,
    operation: ProjectCommandOperation,
    options: ProjectCommandRunOptions = {},
  ): Promise<ProcessResult> {
    return this.run(project, operation, options);
  }

  /** Requests graceful termination of the active command for a project. */
  public stop(projectId: string): boolean {
    const controller = this.#active.get(projectId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }
}

function commandFor(
  project: ProjectConfig,
  operation: ProjectCommandOperation,
): ProjectCommand | undefined {
  switch (operation) {
    case "test": return project.testCommand;
    case "build": return project.buildCommand;
    case "run": return project.runCommand;
  }
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (source === undefined) return () => undefined;
  if (source.aborted) target.abort();
  const abort = (): void => target.abort();
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}
