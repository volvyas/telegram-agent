import type { GitTaskSnapshot } from "../domain/GitSnapshot.js";
import type {
  PersistedGitSummary,
  PersistedTaskRecord,
  PersistedTaskStatus,
  PersistedTestSummary,
  Storage,
} from "../storage/Storage.js";
import { allocateTaskId } from "./TaskIdGenerator.js";

const DEFAULT_HISTORY_LIMIT = 200;
const MAX_PROMPT_SUMMARY_LENGTH = 160;

export interface TaskManagerOptions {
  readonly clock?: () => Date;
  readonly historyLimit?: number;
}

export interface FinishTaskInput {
  readonly status: Exclude<PersistedTaskStatus, "pending" | "running">;
  readonly exitCode: number | null;
  readonly git: GitTaskSnapshot;
  readonly testSummary?: PersistedTestSummary;
}

export class TaskManager {
  readonly #storage: Storage;
  readonly #clock: () => Date;
  readonly #historyLimit: number;

  public constructor(storage: Storage, options: TaskManagerOptions = {}) {
    this.#storage = storage;
    this.#clock = options.clock ?? (() => new Date());
    this.#historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    if (!Number.isSafeInteger(this.#historyLimit) || this.#historyLimit < 1) {
      throw new RangeError("Task history limit must be a positive integer");
    }
  }

  /** Allocates the ID and inserts its running record in one storage transaction. */
  public async start(projectId: string, prompt: string): Promise<PersistedTaskRecord> {
    const now = this.#clock().toISOString();
    let record: PersistedTaskRecord | undefined;
    await this.#storage.update((state) => {
      const allocated = allocateTaskId(state);
      record = {
        id: allocated.id,
        projectId,
        promptSummary: summarizePrompt(prompt),
        status: "running",
        createdAt: now,
        startedAt: now,
        updatedAt: now,
        exitCode: null,
        testSummary: { status: "not_run" },
      };
      return {
        ...allocated.state,
        tasks: boundHistory([...allocated.state.tasks, record], this.#historyLimit),
      };
    });
    if (record === undefined) throw new Error("Task creation did not complete");
    return Object.freeze(record);
  }

  public async finish(taskId: string, input: FinishTaskInput): Promise<PersistedTaskRecord> {
    const finishedAt = this.#clock().toISOString();
    let completed: PersistedTaskRecord | undefined;
    await this.#storage.update((state) => {
      const index = state.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) throw new Error(`Unknown task ID: ${taskId}`);
      const current = state.tasks[index];
      if (current === undefined) throw new Error(`Unknown task ID: ${taskId}`);
      const startedAt = current.startedAt ?? current.createdAt;
      completed = {
        ...current,
        status: input.status,
        finishedAt,
        updatedAt: finishedAt,
        durationMs: Math.max(0, new Date(finishedAt).valueOf() - new Date(startedAt).valueOf()),
        exitCode: input.exitCode,
        testSummary: input.testSummary ?? current.testSummary ?? { status: "not_run" },
        gitSummary: summarizeGit(input.git),
      };
      const tasks = [...state.tasks];
      tasks[index] = completed;
      return { ...state, tasks: boundHistory(tasks, this.#historyLimit, current.id) };
    });
    if (completed === undefined) throw new Error("Task completion did not complete");
    return Object.freeze(completed);
  }

  /** Reopens the latest question turn without storing the user's answer. */
  public async resumeWaiting(projectId: string): Promise<PersistedTaskRecord | undefined> {
    const updatedAt = this.#clock().toISOString();
    let resumed: PersistedTaskRecord | undefined;
    await this.#storage.update((state) => {
      const index = state.tasks.findLastIndex(
        (task) => task.projectId === projectId && task.status === "waiting_for_user",
      );
      if (index < 0) return state;
      const current = state.tasks[index];
      if (current === undefined) return state;
      resumed = { ...current, status: "running", updatedAt };
      const tasks = [...state.tasks];
      tasks[index] = resumed;
      return { ...state, tasks: boundHistory(tasks, this.#historyLimit, current.id) };
    });
    return resumed === undefined ? undefined : Object.freeze(resumed);
  }

  public async fail(taskId: string, exitCode: number | null = null): Promise<PersistedTaskRecord> {
    const finishedAt = this.#clock().toISOString();
    let failed: PersistedTaskRecord | undefined;
    await this.#storage.update((state) => {
      const index = state.tasks.findIndex((task) => task.id === taskId);
      if (index < 0) throw new Error(`Unknown task ID: ${taskId}`);
      const current = state.tasks[index];
      if (current === undefined) throw new Error(`Unknown task ID: ${taskId}`);
      const startedAt = current.startedAt ?? current.createdAt;
      failed = {
        ...current,
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        durationMs: Math.max(0, new Date(finishedAt).valueOf() - new Date(startedAt).valueOf()),
        exitCode,
        testSummary: current.testSummary ?? { status: "not_run" },
      };
      const tasks = [...state.tasks];
      tasks[index] = failed;
      return { ...state, tasks: boundHistory(tasks, this.#historyLimit, taskId) };
    });
    if (failed === undefined) throw new Error("Task failure update did not complete");
    return Object.freeze(failed);
  }

  public async recent(projectId: string, limit = 10): Promise<readonly PersistedTaskRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#historyLimit) {
      throw new RangeError("Task history query limit is invalid");
    }
    return Object.freeze((await this.#storage.load()).tasks
      .filter((task) => task.projectId === projectId)
      .slice(-limit)
      .reverse());
  }

  /** Marks work that cannot survive a process restart as interrupted. */
  public async reconcileInterrupted(): Promise<void> {
    const finishedAt = this.#clock().toISOString();
    await this.#storage.update((state) => {
      let changed = false;
      const tasks = state.tasks.map((task) => {
        if (task.status !== "running" && task.status !== "pending") return task;
        changed = true;
        const startedAt = task.startedAt ?? task.createdAt;
        return {
          ...task,
          status: "failed" as const,
          finishedAt,
          updatedAt: finishedAt,
          durationMs: Math.max(0, new Date(finishedAt).valueOf() - new Date(startedAt).valueOf()),
          exitCode: null,
        };
      });
      return changed ? { ...state, tasks } : state;
    });
  }
}

export function summarizePrompt(prompt: string): string {
  const normalized = [...prompt]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .trim()
    .replace(/\s+/gu, " ");
  return normalized.length <= MAX_PROMPT_SUMMARY_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_PROMPT_SUMMARY_LENGTH - 1)}…`;
}

export function summarizeGit(git: GitTaskSnapshot): PersistedGitSummary {
  return Object.freeze({
    branchBefore: git.before.branch,
    branchAfter: git.after.branch,
    cleanBefore: git.before.clean,
    cleanAfter: git.after.clean,
    changedFiles: git.after.changedFiles.length,
    additions: git.after.numstat.additions,
    deletions: git.after.numstat.deletions,
    observedDuringTaskFiles: git.comparison.observedDuringTaskFiles.length,
  });
}

function boundHistory(
  tasks: readonly PersistedTaskRecord[],
  limit: number,
  preserveId?: string,
): readonly PersistedTaskRecord[] {
  if (tasks.length <= limit) return tasks;
  const isActive = (task: PersistedTaskRecord): boolean =>
    task.status === "running" || task.status === "pending" || task.status === "waiting_for_user";
  const active = tasks.filter(isActive);
  const terminalCapacity = Math.max(0, limit - active.length);
  const terminal = tasks.filter((task) => !isActive(task));
  const retainedTerminalIds = new Set(
    (terminalCapacity === 0 ? [] : terminal.slice(-terminalCapacity)).map((task) => task.id),
  );
  if (preserveId !== undefined) retainedTerminalIds.add(preserveId);
  return tasks.filter((task) =>
    isActive(task) || retainedTerminalIds.has(task.id),
  );
}
