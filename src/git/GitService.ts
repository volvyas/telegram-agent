import { isAbsolute } from "node:path";

import {
  allowEnvironment,
  ProcessRunner,
  type ProcessResult,
} from "../process/ProcessRunner.js";
import {
  parseNumstat,
  parsePorcelainStatus,
  type GitNumstatSummary,
  type GitPorcelainEntry,
} from "./GitOutputParser.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_PREFIX = ["--no-optional-locks"] as const;

export interface GitStatus {
  readonly branch: string | null;
  readonly clean: boolean;
  readonly porcelain: readonly GitPorcelainEntry[];
  readonly changedFiles: readonly string[];
  readonly numstat: GitNumstatSummary;
}

export class GitServiceError extends Error {
  public readonly code: "INVALID_REPOSITORY_PATH" | "GIT_COMMAND_FAILED" | "GIT_OUTPUT_TRUNCATED";

  public constructor(
    code: GitServiceError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitServiceError";
    this.code = code;
  }
}

export class GitService {
  readonly #runner: ProcessRunner;
  readonly #environment: Readonly<Record<string, string>>;

  public constructor(
    runner = new ProcessRunner(),
    environment = allowEnvironment(process.env, [
      "PATH",
      "LANG",
      "LC_ALL",
      "SYSTEMROOT",
      "WINDIR",
    ]),
  ) {
    this.#runner = runner;
    this.#environment = Object.freeze({ ...environment });
  }

  public async getStatus(repositoryPath: string): Promise<GitStatus> {
    validateRepositoryPath(repositoryPath);

    const [statusResult, branchResult, headResult] = await Promise.all([
      this.#git(repositoryPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.#git(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.#git(repositoryPath, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    ]);

    requireSuccess(statusResult, "status");
    const branch = readBranch(branchResult);
    const hasHead = readHeadState(headResult);
    const numstatResult = await this.#git(
      repositoryPath,
      hasHead
        ? ["diff", "--numstat", "-z", "HEAD", "--"]
        : ["diff", "--cached", "--numstat", "-z", "--"],
    );
    requireSuccess(numstatResult, "diff --numstat");

    const porcelain = parsePorcelainStatus(statusResult.stdout);
    const changedFiles = Object.freeze([
      ...new Set(
        porcelain.flatMap((entry) =>
          entry.originalPath === undefined
            ? [entry.path]
            : [entry.originalPath, entry.path],
        ),
      ),
    ]);

    return Object.freeze({
      branch,
      clean: porcelain.length === 0,
      porcelain,
      changedFiles,
      numstat: parseNumstat(numstatResult.stdout),
    });
  }

  async #git(repositoryPath: string, args: readonly string[]): Promise<ProcessResult> {
    try {
      return await this.#runner.run({
        executable: "git",
        args: [...GIT_PREFIX, ...args],
        cwd: repositoryPath,
        env: this.#environment,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      throw new GitServiceError("GIT_COMMAND_FAILED", "Unable to execute Git command", {
        cause: error,
      });
    }
  }
}

function validateRepositoryPath(repositoryPath: string): void {
  if (!isAbsolute(repositoryPath) || repositoryPath.includes("\0")) {
    throw new GitServiceError(
      "INVALID_REPOSITORY_PATH",
      "Git repository path must be an absolute safe path",
    );
  }
}

function requireSuccess(result: ProcessResult, operation: string): void {
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new GitServiceError(
      "GIT_OUTPUT_TRUNCATED",
      `Git ${operation} output exceeded the configured limit`,
    );
  }
  if (result.exitCode !== 0 || result.terminationReason !== undefined) {
    throw new GitServiceError("GIT_COMMAND_FAILED", `Git ${operation} failed`);
  }
}

function readBranch(result: ProcessResult): string | null {
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new GitServiceError("GIT_OUTPUT_TRUNCATED", "Git branch output was truncated");
  }
  if (result.exitCode === 1 && result.terminationReason === undefined) {
    return null;
  }
  requireSuccess(result, "branch lookup");
  const branch = result.stdout.trimEnd();
  if (branch.length === 0 || branch.includes("\0") || branch.includes("\n")) {
    throw new GitServiceError("GIT_COMMAND_FAILED", "Git returned an invalid branch name");
  }
  return branch;
}

function readHeadState(result: ProcessResult): boolean {
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new GitServiceError("GIT_OUTPUT_TRUNCATED", "Git revision output was truncated");
  }
  if (result.exitCode === 1 && result.terminationReason === undefined) {
    return false;
  }
  requireSuccess(result, "revision lookup");
  return true;
}
