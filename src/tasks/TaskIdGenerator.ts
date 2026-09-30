import type { PersistedState, Storage } from "../storage/Storage.js";

export const TASK_ID_MAX = 9_999_999_999;

export class TaskIdGenerator {
  readonly #storage: Storage;

  public constructor(storage: Storage) {
    this.#storage = storage;
  }

  /** Atomically reserves an ID. Gaps are allowed; reuse is not. */
  public async generate(): Promise<string> {
    let id: string | undefined;
    await this.#storage.update((state) => {
      const allocated = allocateTaskId(state);
      id = allocated.id;
      return allocated.state;
    });
    if (id === undefined) throw new Error("Task ID allocation did not complete");
    return id;
  }
}

export function allocateTaskId(state: PersistedState): { readonly id: string; readonly state: PersistedState } {
  const taskNumber = state.sequence.nextTaskNumber;
  if (taskNumber > TASK_ID_MAX) throw new RangeError("Task ID sequence is exhausted");
  return {
    id: `TASK-${String(taskNumber).padStart(4, "0")}`,
    state: { ...state, sequence: { nextTaskNumber: taskNumber + 1 } },
  };
}
