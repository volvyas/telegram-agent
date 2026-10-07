import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectConfigError } from "../../src/config/ProjectConfig.js";
import { GITHUB_ISSUE_TRACKER_LIMITS } from "../../src/config/IssueTrackerConfig.js";
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
  it("loads an immutable model-specific context budget", async () => {
    const path = await createGitRepository("context");
    const context = { windowTokens: 32768, outputReserveTokens: 4096, safetyMarginTokens: 2048 };
    const manager = await ProjectManager.fromDocument({
      modelProviders: { local: { type: "codex-builtin", provider: "ollama" } },
      projects: { context: { ...projectDocument("Context", path, ["task"]), agent: { provider: "local", model: "qwen", context } } },
    });
    expect(manager.require("context").agent?.context).toEqual(context);
    expect(Object.isFrozen(manager.require("context").agent?.context)).toBe(true);
  });

  it.each([
    null, {}, { windowTokens: "32768", outputReserveTokens: 4096, safetyMarginTokens: 2048 },
    { windowTokens: 32768, outputReserveTokens: 0, safetyMarginTokens: 2048 },
    { windowTokens: 32768, outputReserveTokens: 4096, safetyMarginTokens: -1 },
    { windowTokens: 32768, outputReserveTokens: 4096.5, safetyMarginTokens: 2048 },
    { windowTokens: 100, outputReserveTokens: 50, safetyMarginTokens: 50 },
    { windowTokens: 100, outputReserveTokens: 101, safetyMarginTokens: 1 },
    { windowTokens: Number.MAX_SAFE_INTEGER + 1, outputReserveTokens: 1, safetyMarginTokens: 1 },
    { windowTokens: 32768, outputReserveTokens: 4096, safetyMarginTokens: 2048, unknown: true },
  ])("rejects invalid context budgets: %j", async (context) => {
    const path = await createGitRepository("bad-context");
    await expect(ProjectManager.fromDocument({
      modelProviders: { local: { type: "codex-builtin", provider: "ollama" } },
      projects: { test: { ...projectDocument("Test", path, ["task"]), agent: { provider: "local", model: "qwen", context } } },
    })).rejects.toBeInstanceOf(ProjectConfigError);
  });

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
          codexHome: "/var/lib/codex-remote/profiles/first",
          testCommand: { executable: "./mvnw", args: ["test", "-q"] },
          branch: "main",
        },
      },
    });

    expect(manager.list().map((project) => project.id)).toEqual(["first", "second"]);
    expect(manager.require("first").path).toBe(first);
    expect(manager.require("first").codexHome).toBe("/var/lib/codex-remote/profiles/first");
    expect(manager.require("first").testCommand).toEqual({
      executable: "./mvnw",
      args: ["test", "-q"],
    });
    expect([...manager.require("first").allowedOperations]).toEqual(["task", "test"]);
    expect(manager.get("missing")).toBeUndefined();
  });

  it("loads reusable built-in and generic Responses providers", async () => {
    const repository = await createGitRepository("providers");
    const manager = await ProjectManager.fromDocument({
      modelProviders: {
        openai: { type: "codex-builtin", provider: "openai" },
        local: {
          type: "responses",
          name: " Home llama ",
          baseUrl: "http://192.168.1.179:8080/v1/",
          wireApi: "responses",
          apiKeyEnv: "HOME_LLAMA_API_KEY",
        },
      },
      projects: {
        providers: {
          ...projectDocument("Providers", repository, ["task"]),
          agent: { provider: "local", model: "qwen-coder" },
        },
      },
    });

    expect([...manager.modelProviders()]).toEqual([
      ["openai", { type: "codex-builtin", provider: "openai" }],
      ["local", {
        type: "responses",
        name: "Home llama",
        baseUrl: "http://192.168.1.179:8080/v1",
        wireApi: "responses",
        apiKeyEnv: "HOME_LLAMA_API_KEY",
      }],
    ]);
    expect(manager.require("providers").agent).toEqual({
      provider: "local",
      model: "qwen-coder",
    });
  });

  it.each([
    [{ type: "codex-builtin", provider: "unsupported" }, "MODEL_PROVIDER_INVALID"],
    [{ type: "responses", name: "x", baseUrl: "not-a-url", wireApi: "responses" }, "MODEL_PROVIDER_INVALID"],
    [{ type: "responses", name: "x", baseUrl: "http://public.example/v1", wireApi: "responses" }, "MODEL_PROVIDER_INVALID"],
    [{ type: "responses", name: "x", baseUrl: "https://user:pass@example.test/v1", wireApi: "responses" }, "MODEL_PROVIDER_INVALID"],
    [{ type: "responses", name: "x", baseUrl: "https://example.test/v1?token=secret", wireApi: "responses" }, "MODEL_PROVIDER_INVALID"],
    [{ type: "responses", name: "x", baseUrl: "https://example.test/v1", wireApi: "chat" }, "MODEL_PROVIDER_INVALID"],
    [{ type: "responses", name: "x", baseUrl: "https://example.test/v1", wireApi: "responses", headers: {} }, "MODEL_PROVIDER_INVALID"],
  ])("rejects unsafe or unsupported provider definitions", async (provider, code) => {
    const repository = await createGitRepository("invalid-provider");
    await expect(ProjectManager.fromDocument({
      modelProviders: { local: provider },
      projects: { demo: projectDocument("Demo", repository, ["task"]) },
    })).rejects.toMatchObject({ code });
  });

  it("rejects an unknown project provider reference", async () => {
    const repository = await createGitRepository("unknown-provider");
    await expect(ProjectManager.fromDocument({
      modelProviders: {},
      projects: {
        demo: {
          ...projectDocument("Demo", repository, ["task"]),
          agent: { provider: "missing", model: "model" },
        },
      },
    })).rejects.toMatchObject({
      code: "MODEL_PROVIDER_REFERENCE_UNKNOWN",
      projectId: "demo",
    });
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
    [
      {
        projects: {
          demo: {
            ...projectDocument("Demo", "/tmp", ["task"]),
            codexHome: "relative/codex-home",
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

  it("loads disabled, GitHub and reserved Jira tracker configurations together", async () => {
    const plain = await createGitRepository("plain");
    const github = await createGitRepository("github");
    const jira = await createGitRepository("jira");
    const manager = await ProjectManager.fromDocument({
      projects: {
        plain: projectDocument("Plain", plain, ["task"]),
        github: {
          ...projectDocument("GitHub", github, ["task"]),
          issueTracker: {
            type: "github",
            owner: "example-org",
            repository: "service.api",
            tokenEnv: "GITHUB_SERVICE_TOKEN",
            apiVersion: "2026-03-10",
          },
        },
        jira: {
          ...projectDocument("Jira", jira, ["task"]),
          issueTracker: { type: "jira" },
        },
      },
    });

    expect(manager.require("plain").issueTracker).toBeUndefined();
    expect(manager.require("jira").issueTracker).toEqual({ type: "jira" });
    expect(manager.require("github").issueTracker).toEqual({
      type: "github",
      owner: "example-org",
      repository: "service.api",
      tokenEnv: "GITHUB_SERVICE_TOKEN",
      apiBaseUrl: "https://api.github.com",
      apiVersion: "2026-03-10",
      pageSize: 10,
      limits: GITHUB_ISSUE_TRACKER_LIMITS,
    });
    expect(Object.isFrozen(manager.require("github").issueTracker)).toBe(true);
    expect(Object.isFrozen(GITHUB_ISSUE_TRACKER_LIMITS)).toBe(true);
  });

  it("normalizes an explicit GitHub Enterprise API base URL", async () => {
    const repository = await createGitRepository("ghes");
    const manager = await ProjectManager.fromDocument({
      projects: {
        ghes: {
          ...projectDocument("GHES", repository, ["task"]),
          issueTracker: {
            type: "github",
            owner: "platform",
            repository: "gateway",
            tokenEnv: "GHES_ISSUES_TOKEN",
            apiBaseUrl: "https://github.corp.example/api/v3/",
            apiVersion: "2022-11-28",
            pageSize: 50,
          },
        },
      },
    });

    expect(manager.require("ghes").issueTracker).toMatchObject({
      apiBaseUrl: "https://github.corp.example/api/v3",
      pageSize: 50,
    });
  });

  it.each([
    [{}, "ISSUE_TRACKER_INVALID"],
    [{ type: "gitlab" }, "ISSUE_TRACKER_PROVIDER_UNKNOWN"],
    [{ type: "jira", baseUrl: "https://jira.example" }, "ISSUE_TRACKER_INVALID"],
    [{ type: "github", owner: "org" }, "ISSUE_TRACKER_INVALID"],
    [{ type: "github", owner: "org", repository: "repo", tokenEnv: "TOKEN", apiVersion: "latest" }, "ISSUE_TRACKER_INVALID"],
    [{ type: "github", owner: "org", repository: "repo", tokenEnv: "TOKEN", apiVersion: "2026-02-30" }, "ISSUE_TRACKER_INVALID"],
    [{ type: "github", owner: "org/name", repository: "repo", tokenEnv: "TOKEN", apiVersion: "2026-03-10" }, "ISSUE_TRACKER_INVALID"],
    [{ type: "github", owner: "org", repository: "repo", tokenEnv: "lowercase", apiVersion: "2026-03-10" }, "ISSUE_TRACKER_INVALID"],
    [{ type: "github", owner: "org", repository: "repo", tokenEnv: "TOKEN", apiVersion: "2026-03-10", pageSize: 51 }, "ISSUE_TRACKER_INVALID"],
    [{ type: "github", owner: "org", repository: "repo", tokenEnv: "TOKEN", apiVersion: "2026-03-10", apiBaseUrl: "http://github.example/api/v3" }, "ISSUE_TRACKER_INVALID"],
    [{ type: "github", owner: "org", repository: "repo", tokenEnv: "TOKEN", apiVersion: "2026-03-10", apiBaseUrl: "https://github.example/rest" }, "ISSUE_TRACKER_INVALID"],
    [{ type: "github", owner: "org", repository: "repo", tokenEnv: "TOKEN", apiVersion: "2026-03-10", extra: true }, "ISSUE_TRACKER_INVALID"],
  ])("rejects invalid issue tracker configuration safely", async (issueTracker, code) => {
    const repository = await createGitRepository("invalid-tracker");
    await expect(ProjectManager.fromDocument({
      projects: {
        demo: { ...projectDocument("Demo", repository, ["task"]), issueTracker },
      },
    })).rejects.toMatchObject({ code, projectId: "demo" });
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
