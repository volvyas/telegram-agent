import type { GitStatusReader } from "../../src/agent/AgentManager.js";
import type { GitStatus } from "../../src/git/GitService.js";

export const CLEAN_GIT_STATUS: GitStatus = Object.freeze({
  branch: "main",
  clean: true,
  porcelain: Object.freeze([]),
  changedFiles: Object.freeze([]),
  numstat: Object.freeze({
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    binaryFiles: 0,
    entries: Object.freeze([]),
  }),
});

export const CLEAN_GIT_STATUS_READER: GitStatusReader = Object.freeze({
  getStatus: () => Promise.resolve(CLEAN_GIT_STATUS),
});
