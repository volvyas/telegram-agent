import type { GitNumstatSummary, GitPorcelainEntry } from "../git/GitOutputParser.js";
import type { GitStatus } from "../git/GitService.js";

/** Immutable observation of the repository working tree at one instant. */
export interface GitSnapshot {
  readonly capturedAt: string;
  readonly branch: string | null;
  readonly clean: boolean;
  readonly porcelain: readonly GitPorcelainEntry[];
  readonly changedFiles: readonly string[];
  /** Diff against HEAD at capture time; untracked files have no numstat. */
  readonly numstat: GitNumstatSummary;
}

/**
 * Path-level comparison only. It deliberately does not claim that the agent was
 * the author: users and other processes can edit the repository concurrently.
 */
export interface GitTaskComparison {
  readonly attribution: "observation_only";
  readonly preExistingChangedFiles: readonly string[];
  readonly preExistingFilesStillChanged: readonly string[];
  readonly observedDuringTaskFiles: readonly string[];
  readonly noLongerChangedFiles: readonly string[];
}

export interface GitTaskSnapshot {
  readonly before: GitSnapshot;
  readonly after: GitSnapshot;
  readonly comparison: GitTaskComparison;
}

export function createGitSnapshot(status: GitStatus, capturedAt: string): GitSnapshot {
  return Object.freeze({
    capturedAt,
    branch: status.branch,
    clean: status.clean,
    porcelain: Object.freeze([...status.porcelain]),
    changedFiles: Object.freeze([...status.changedFiles]),
    numstat: Object.freeze({
      ...status.numstat,
      entries: Object.freeze([...status.numstat.entries]),
    }),
  });
}

export function compareGitSnapshots(
  before: GitSnapshot,
  after: GitSnapshot,
): GitTaskComparison {
  const beforeFiles = new Set(before.changedFiles);
  const afterFiles = new Set(after.changedFiles);

  return Object.freeze({
    attribution: "observation_only",
    preExistingChangedFiles: Object.freeze([...before.changedFiles]),
    preExistingFilesStillChanged: Object.freeze(
      before.changedFiles.filter((path) => afterFiles.has(path)),
    ),
    observedDuringTaskFiles: Object.freeze(
      after.changedFiles.filter((path) => !beforeFiles.has(path)),
    ),
    noLongerChangedFiles: Object.freeze(
      before.changedFiles.filter((path) => !afterFiles.has(path)),
    ),
  });
}

export function createGitTaskSnapshot(
  before: GitSnapshot,
  after: GitSnapshot,
): GitTaskSnapshot {
  return Object.freeze({ before, after, comparison: compareGitSnapshots(before, after) });
}
