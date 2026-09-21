import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitService, GitServiceError } from "../../src/git/GitService.js";
import { allowEnvironment, ProcessRunner } from "../../src/process/ProcessRunner.js";

const temporaryDirectories: string[] = [];
const runner = new ProcessRunner();
const gitEnvironment = allowEnvironment(process.env, ["PATH", "LANG", "LC_ALL"]);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("GitService", () => {
  it("returns branch and an empty typed status for a clean repository", async () => {
    const repository = await createRepository();
    const service = new GitService();

    const status = await service.getStatus(repository);

    expect(status).toEqual({
      branch: "main",
      clean: true,
      porcelain: [],
      changedFiles: [],
      numstat: {
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        binaryFiles: 0,
        entries: [],
      },
    });
  });

  it("reports staged, unstaged and untracked files with special names", async () => {
    const repository = await createRepository();
    const trackedPath = "tracked\narrow\tї.txt";
    const stagedPath = "staged -> file.txt";
    const untrackedPath = "untracked\n[odd]\tname.txt";
    await writeFile(join(repository, trackedPath), "first\n");
    await git(repository, ["add", "--", trackedPath]);
    await git(repository, ["commit", "-q", "-m", "add special file"]);

    await appendFile(join(repository, trackedPath), "second\n");
    await writeFile(join(repository, stagedPath), "one\ntwo\n");
    await git(repository, ["add", "--", stagedPath]);
    await writeFile(join(repository, untrackedPath), "not in numstat\n");

    const status = await new GitService().getStatus(repository);

    expect(status.branch).toBe("main");
    expect(status.clean).toBe(false);
    expect(status.porcelain).toEqual(
      expect.arrayContaining([
        {
          path: trackedPath,
          index: " ",
          workTree: "M",
          kind: "modified",
        },
        {
          path: stagedPath,
          index: "A",
          workTree: " ",
          kind: "added",
        },
        {
          path: untrackedPath,
          index: "?",
          workTree: "?",
          kind: "untracked",
        },
      ]),
    );
    expect(status.changedFiles).toEqual(
      expect.arrayContaining([trackedPath, stagedPath, untrackedPath]),
    );
    expect(status.changedFiles).toHaveLength(3);
    expect(status.numstat).toMatchObject({
      filesChanged: 2,
      additions: 3,
      deletions: 0,
      binaryFiles: 0,
    });
    expect(status.numstat.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([trackedPath, stagedPath]),
    );
  });

  it("handles an unborn repository and staged content", async () => {
    const parent = await createTemporaryDirectory();
    const repository = join(parent, "unborn");
    await mkdir(repository);
    await git(repository, ["init", "-q", "-b", "topic/special"]);
    await writeFile(join(repository, "new.txt"), "one\ntwo\n");
    await git(repository, ["add", "--", "new.txt"]);

    const status = await new GitService().getStatus(repository);

    expect(status.branch).toBe("topic/special");
    expect(status.porcelain).toEqual([
      {
        path: "new.txt",
        index: "A",
        workTree: " ",
        kind: "added",
      },
    ]);
    expect(status.numstat).toMatchObject({ filesChanged: 1, additions: 2, deletions: 0 });
  });

  it("rejects invalid paths and non-repositories with typed errors", async () => {
    const directory = await createTemporaryDirectory();
    const service = new GitService();

    await expect(service.getStatus("relative/path")).rejects.toMatchObject({
      code: "INVALID_REPOSITORY_PATH",
    });
    await expect(service.getStatus(directory)).rejects.toBeInstanceOf(GitServiceError);
  });
});

async function createRepository(): Promise<string> {
  const parent = await createTemporaryDirectory();
  const repository = join(parent, "repository");
  await mkdir(repository);
  await git(repository, ["init", "-q", "-b", "main"]);
  await git(repository, ["config", "user.email", "tests@example.invalid"]);
  await git(repository, ["config", "user.name", "Test User"]);
  await writeFile(join(repository, "README.md"), "initial\n");
  await git(repository, ["add", "--", "README.md"]);
  await git(repository, ["commit", "-q", "-m", "initial"]);
  return repository;
}

async function git(repository: string, args: readonly string[]): Promise<void> {
  const result = await runner.run({
    executable: "git",
    args,
    cwd: repository,
    env: gitEnvironment,
  });
  expect(result.exitCode, result.stderr).toBe(0);
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-remote-git-test-"));
  temporaryDirectories.push(path);
  return path;
}
