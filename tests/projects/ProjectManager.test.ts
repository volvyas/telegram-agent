import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectConfigError } from "../../src/config/ProjectConfig.js";
import { ProcessRunner, allowEnvironment } from "../../src/process/ProcessRunner.js";
import { ProjectManager } from "../../src/projects/ProjectManager.js";

const temporaryDirectories: string[] = [];
const runner = new ProcessRunner();

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("ProjectManager", () => {
  it("loads, canonicalizes, lists and retrieves valid projects", async () => {
    const first = await createGitRepository("first");
    const second = await createGitRepository("second");
    const firstLink = join(await createTemporaryDirectory(), "first-link");
    await symlink(first, firstLink);

    const manager = await ProjectManager.fromDocument({
      projects: {
        second: projectDocument("Second", second, ["task"]),
        first: {
          ...projectDocument("First", firstLink, ["task", "test"]),
          testCommand: { executable: "./mvnw", args: ["test", "-q"] },
          branch: "main",
        },
      },
    });

    expect(manager.list().map((project) => project.id)).toEqual(["first", "second"]);
    expect(manager.require("first").path).toBe(first);
    expect(manager.require("first").testCommand).toEqual({
      executable: "./mvnw",
      args: ["test", "-q"],
    });
    expect([...manager.require("first").allowedOperations]).toEqual(["task", "test"]);
    expect(manager.get("missing")).toBeUndefined();
  });

  it("rejects duplicate canonical repository paths", async () => {
    const repository = await createGitRepository("duplicate");

    await expect(
      ProjectManager.fromDocument({
        projects: {
          one: projectDocument("One", repository, ["task"]),
          two: projectDocument("Two", repository, ["task"]),
        },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_PATH_DUPLICATE", projectId: "two" });
  });

  it("rejects a directory that is not a Git repository", async () => {
    const directory = await createTemporaryDirectory();

    await expect(
      ProjectManager.fromDocument({
        projects: { demo: projectDocument("Demo", directory, ["task"]) },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_GIT_REPOSITORY" });
  });

  it("rejects a subdirectory instead of silently widening to the Git root", async () => {
    const repository = await createGitRepository("root");
    const subdirectory = join(repository, "nested");
    await mkdir(subdirectory);

    await expect(
      ProjectManager.fromDocument({
        projects: { demo: projectDocument("Demo", subdirectory, ["task"]) },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_PATH_NOT_GIT_ROOT" });
  });

  it.each([
    [{}, "PROJECTS_DOCUMENT_INVALID"],
    [{ projects: {} }, "PROJECTS_EMPTY"],
    [
      { projects: { "Bad ID": projectDocument("Demo", "/tmp", ["task"]) } },
      "PROJECT_ID_INVALID",
    ],
    [
      { projects: { demo: projectDocument("Demo", "/tmp", ["shell"]) } },
      "PROJECT_INVALID",
    ],
    [
      {
        projects: {
          demo: {
            ...projectDocument("Demo", "/tmp", ["task"]),
            testCommand: "npm test",
          },
        },
      },
      "PROJECT_INVALID",
    ],
  ])("rejects invalid project documents", async (document, code) => {
    await expect(ProjectManager.fromDocument(document)).rejects.toMatchObject({ code });
  });

  it("throws a typed error for an unknown project", async () => {
    const repository = await createGitRepository("known");
    const manager = await ProjectManager.fromDocument({
      projects: { known: projectDocument("Known", repository, ["task"]) },
    });

    expect(() => manager.require("missing")).toThrow(ProjectConfigError);
    expect(() => manager.require("missing")).toThrow("Project is not configured");
  });
});

function projectDocument(name: string, path: string, allowedOperations: string[]) {
  return { name, path, allowedOperations };
}

async function createGitRepository(name: string): Promise<string> {
  const parent = await createTemporaryDirectory();
  const repository = join(parent, name);
  await mkdir(repository);
  const result = await runner.run({
    executable: "git",
    args: ["init", "-q", "-b", "main"],
    cwd: repository,
    env: allowEnvironment(process.env, ["PATH", "LANG", "LC_ALL"]),
  });
  expect(result.exitCode).toBe(0);
  return repository;
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-remote-project-test-"));
  temporaryDirectories.push(path);
  return path;
}
