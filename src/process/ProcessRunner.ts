import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_000;

export type ProcessTerminationReason = "aborted" | "timed_out";

export interface ProcessRequest {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  readonly terminationReason?: ProcessTerminationReason;
}

export class ProcessRunnerError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcessRunnerError";
  }
}

export function allowEnvironment(
  source: NodeJS.ProcessEnv,
  names: readonly string[],
): Readonly<Record<string, string>> {
  const allowed: Record<string, string> = {};

  for (const name of names) {
    const value = source[name];
    if (value !== undefined) {
      allowed[name] = value;
    }
  }

  return Object.freeze(allowed);
}

export class ProcessRunner {
  public run(request: ProcessRequest): Promise<ProcessResult> {
    validateRequest(request);

    if (request.signal?.aborted === true) {
      throw new ProcessRunnerError("Process was aborted before it started");
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const startedAt = performance.now();
      const detached = process.platform !== "win32";
      const child = spawn(request.executable, [...(request.args ?? [])], {
        cwd: request.cwd,
        detached,
        env: { ...request.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const stdout = new BoundedOutput(
        request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        request.onStdout,
      );
      const stderr = new BoundedOutput(
        request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        request.onStderr,
      );
      let settled = false;
      let terminationReason: ProcessTerminationReason | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timeoutTimer !== undefined) {
          clearTimeout(timeoutTimer);
        }
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
        request.signal?.removeEventListener("abort", abortHandler);
      };

      const terminate = (reason: ProcessTerminationReason): void => {
        if (settled || child.exitCode !== null || child.signalCode !== null) {
          return;
        }

        terminationReason ??= reason;
        killProcessTree(child, detached, "SIGTERM");
        forceKillTimer = setTimeout(() => {
          killProcessTree(child, detached, "SIGKILL");
        }, request.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        forceKillTimer.unref();
      };

      const abortHandler = (): void => {
        terminate("aborted");
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.write(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.write(chunk);
      });

      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new ProcessRunnerError("Unable to start process", { cause: error }));
      });

      child.once("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        stdout.end();
        stderr.end();

        const baseResult = {
          exitCode,
          signal,
          stdout: stdout.value,
          stderr: stderr.value,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          durationMs: Math.round(performance.now() - startedAt),
        };
        const result: ProcessResult =
          terminationReason === undefined
            ? baseResult
            : { ...baseResult, terminationReason };

        resolve(Object.freeze(result));
      });

      request.signal?.addEventListener("abort", abortHandler, { once: true });

      if (request.timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => {
          terminate("timed_out");
        }, request.timeoutMs);
        timeoutTimer.unref();
      }

      child.stdin.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE" && !settled) {
          terminate("aborted");
        }
      });
      child.stdin.end(request.stdin);
    });
  }
}

class BoundedOutput {
  readonly #decoder = new StringDecoder("utf8");
  readonly #parts: string[] = [];
  readonly #maxBytes: number;
  readonly #onChunk: ((chunk: string) => void) | undefined;
  #storedBytes = 0;
  #truncated = false;

  public constructor(maxBytes: number, onChunk?: (chunk: string) => void) {
    this.#maxBytes = maxBytes;
    this.#onChunk = onChunk;
  }

  public get value(): string {
    return this.#parts.join("");
  }

  public get truncated(): boolean {
    return this.#truncated;
  }

  public write(chunk: Buffer): void {
    const decoded = this.#decoder.write(chunk);
    this.#onChunk?.(decoded);
    this.#append(decoded);
  }

  public end(): void {
    const decoded = this.#decoder.end();
    if (decoded.length > 0) {
      this.#onChunk?.(decoded);
      this.#append(decoded);
    }
  }

  #append(value: string): void {
    const bytes = Buffer.byteLength(value);
    const remaining = this.#maxBytes - this.#storedBytes;

    if (remaining <= 0) {
      this.#truncated ||= bytes > 0;
      return;
    }

    if (bytes <= remaining) {
      this.#parts.push(value);
      this.#storedBytes += bytes;
      return;
    }

    const encoded = Buffer.from(value);
    let safeEnd = remaining;
    while (safeEnd > 0 && (encoded[safeEnd] ?? 0) >= 0x80 && (encoded[safeEnd] ?? 0) < 0xc0) {
      safeEnd -= 1;
    }
    if (safeEnd > 0) {
      this.#parts.push(encoded.subarray(0, safeEnd).toString("utf8"));
    }
    this.#storedBytes = this.#maxBytes;
    this.#truncated = true;
  }
}

function validateRequest(request: ProcessRequest): void {
  if (request.executable.trim().length === 0 || request.executable.includes("\0")) {
    throw new ProcessRunnerError("Executable must be a non-empty safe string");
  }
  if (!isAbsolute(request.cwd)) {
    throw new ProcessRunnerError("Process working directory must be absolute");
  }
  if (request.args?.some((argument) => argument.includes("\0")) === true) {
    throw new ProcessRunnerError("Process arguments must not contain null bytes");
  }
  for (const [name, value] of Object.entries(request.env)) {
    if (name.length === 0 || name.includes("=") || name.includes("\0") || value.includes("\0")) {
      throw new ProcessRunnerError("Process environment contains an invalid entry");
    }
  }
  validatePositiveInteger(request.timeoutMs, "Process timeout");
  validatePositiveInteger(request.killGraceMs, "Process kill grace period");
  validatePositiveInteger(request.maxOutputBytes, "Process output limit");
}

function validatePositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new ProcessRunnerError(`${label} must be a positive integer`);
  }
}

function killProcessTree(
  child: ChildProcess,
  detached: boolean,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  try {
    if (detached) {
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      child.kill(signal);
    }
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}
