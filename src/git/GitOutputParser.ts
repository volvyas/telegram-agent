export type GitFileState =
  | " "
  | "!"
  | "?"
  | "A"
  | "C"
  | "D"
  | "M"
  | "R"
  | "T"
  | "U";

export type GitChangeKind =
  | "added"
  | "copied"
  | "deleted"
  | "ignored"
  | "modified"
  | "renamed"
  | "type_changed"
  | "unmerged"
  | "untracked";

export interface GitPorcelainEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly index: GitFileState;
  readonly workTree: GitFileState;
  readonly kind: GitChangeKind;
}

export interface GitNumstatEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

export interface GitNumstatSummary {
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly binaryFiles: number;
  readonly entries: readonly GitNumstatEntry[];
}

export class GitOutputParserError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitOutputParserError";
  }
}

/** Parses `git status --porcelain=v1 -z` without relying on quoted paths. */
export function parsePorcelainStatus(output: string): readonly GitPorcelainEntry[] {
  if (output.length === 0) {
    return Object.freeze([]);
  }

  const records = splitNullTerminated(output, "porcelain status");
  const entries: GitPorcelainEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4 || record[2] !== " ") {
      throw new GitOutputParserError("Git returned malformed porcelain status");
    }

    const indexState = parseFileState(record[0]);
    const workTreeState = parseFileState(record[1]);
    const path = record.slice(3);
    if (path.length === 0) {
      throw new GitOutputParserError("Git returned an empty status path");
    }

    const hasOriginalPath =
      indexState === "R" ||
      indexState === "C" ||
      workTreeState === "R" ||
      workTreeState === "C";
    if (hasOriginalPath) index += 1;
    const originalPath = hasOriginalPath ? records[index] : undefined;
    if (hasOriginalPath && (originalPath === undefined || originalPath.length === 0)) {
      throw new GitOutputParserError("Git returned a malformed rename status");
    }

    entries.push(
      Object.freeze({
        path,
        ...(originalPath === undefined ? {} : { originalPath }),
        index: indexState,
        workTree: workTreeState,
        kind: classifyChange(indexState, workTreeState),
      }),
    );
  }

  return Object.freeze(entries);
}

/** Parses `git diff --numstat -z`, including its three-field rename form. */
export function parseNumstat(output: string): GitNumstatSummary {
  if (output.length === 0) {
    return freezeNumstat([]);
  }

  const records = splitNullTerminated(output, "numstat");
  const entries: GitNumstatEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) {
      throw new GitOutputParserError("Git returned malformed numstat output");
    }

    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab) {
      throw new GitOutputParserError("Git returned malformed numstat output");
    }

    const additions = parseCount(record.slice(0, firstTab));
    const deletions = parseCount(record.slice(firstTab + 1, secondTab));
    let path = record.slice(secondTab + 1);
    let originalPath: string | undefined;

    if (path.length === 0) {
      index += 1;
      originalPath = records[index];
      index += 1;
      path = records[index] ?? "";
      if (originalPath === undefined || originalPath.length === 0 || path.length === 0) {
        throw new GitOutputParserError("Git returned malformed rename numstat");
      }
    }

    const binary = additions === null || deletions === null;
    entries.push(
      Object.freeze({
        path,
        ...(originalPath === undefined ? {} : { originalPath }),
        additions,
        deletions,
        binary,
      }),
    );
  }

  return freezeNumstat(entries);
}

function splitNullTerminated(output: string, label: string): string[] {
  if (!output.endsWith("\0")) {
    throw new GitOutputParserError(`Git returned unterminated ${label} output`);
  }
  return output.slice(0, -1).split("\0");
}

function parseFileState(value: string | undefined): GitFileState {
  if (
    value === " " ||
    value === "!" ||
    value === "?" ||
    value === "A" ||
    value === "C" ||
    value === "D" ||
    value === "M" ||
    value === "R" ||
    value === "T" ||
    value === "U"
  ) {
    return value;
  }
  throw new GitOutputParserError("Git returned an unknown file status");
}

function classifyChange(index: GitFileState, workTree: GitFileState): GitChangeKind {
  if (index === "?" && workTree === "?") return "untracked";
  if (index === "!" && workTree === "!") return "ignored";
  if (index === "U" || workTree === "U" || isUnmergedPair(index, workTree)) {
    return "unmerged";
  }
  if (index === "R" || workTree === "R") return "renamed";
  if (index === "C" || workTree === "C") return "copied";
  if (index === "A" || workTree === "A") return "added";
  if (index === "D" || workTree === "D") return "deleted";
  if (index === "T" || workTree === "T") return "type_changed";
  return "modified";
}

function isUnmergedPair(index: GitFileState, workTree: GitFileState): boolean {
  const pair = `${index}${workTree}`;
  return pair === "DD" || pair === "AU" || pair === "UD" || pair === "UA" || pair === "DU" || pair === "AA";
}

function parseCount(value: string): number | null {
  if (value === "-") return null;
  if (!/^\d+$/.test(value)) {
    throw new GitOutputParserError("Git returned an invalid numstat count");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new GitOutputParserError("Git returned an out-of-range numstat count");
  }
  return count;
}

function freezeNumstat(entries: readonly GitNumstatEntry[]): GitNumstatSummary {
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;

  for (const entry of entries) {
    additions += entry.additions ?? 0;
    deletions += entry.deletions ?? 0;
    binaryFiles += entry.binary ? 1 : 0;
  }

  return Object.freeze({
    filesChanged: entries.length,
    additions,
    deletions,
    binaryFiles,
    entries: Object.freeze([...entries]),
  });
}
