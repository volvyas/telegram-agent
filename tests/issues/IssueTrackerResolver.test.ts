import { describe, expect, it, vi } from "vitest";

import {
  GITHUB_ISSUE_TRACKER_LIMITS,
  IssueTrackerSecrets,
  type GitHubIssueTrackerConfig,
} from "../../src/config/IssueTrackerConfig.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import type {
  IssueDetails,
  IssuePage,
  IssueReference,
  IssueTracker,
  PageToken,
} from "../../src/issues/IssueTracker.js";
import {
  IssueTrackerResolver,
  type GitHubIssueTrackerFactory,
} from "../../src/issues/IssueTrackerResolver.js";

const githubConfig = Object.freeze({
  type: "github",
  owner: "example",
  repository: "service",
  tokenEnv: "GITHUB_ISSUES_TOKEN",
  apiBaseUrl: "https://api.github.com",
  apiVersion: "2026-03-10",
  pageSize: 10,
  limits: GITHUB_ISSUE_TRACKER_LIMITS,
} satisfies GitHubIssueTrackerConfig);

describe("IssueTrackerResolver", () => {
  it("selects the GitHub adapter using validated config and the project credential", () => {
    const adapter = new StubIssueTracker();
    const factory = vi.fn<GitHubIssueTrackerFactory>(() => adapter);
    const resolver = new IssueTrackerResolver(
      new IssueTrackerSecrets(new Map([["github-project", "read-token"]])),
      factory,
    );

    expect(resolver.resolve(project("github-project", githubConfig))).toBe(adapter);
    expect(factory).toHaveBeenCalledWith(githubConfig, "read-token");
  });

  it("rejects a project without a configured tracker", () => {
    const factory = vi.fn<GitHubIssueTrackerFactory>();
    const resolver = new IssueTrackerResolver(new IssueTrackerSecrets(new Map()), factory);

    expect(() => resolver.resolve(project("plain"))).toThrowError(
      expect.objectContaining({ code: "NOT_CONFIGURED", projectId: "plain" }),
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects reserved Jira with a safe typed unsupported-provider error", () => {
    const factory = vi.fn<GitHubIssueTrackerFactory>();
    const resolver = new IssueTrackerResolver(new IssueTrackerSecrets(new Map()), factory);

    expect(() => resolver.resolve(project("jira-project", { type: "jira" })))
      .toThrowError(expect.objectContaining({
        code: "UNSUPPORTED_PROVIDER",
        provider: "jira",
        projectId: "jira-project",
      }));
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails safely if runtime credentials were not initialized", () => {
    const factory = vi.fn<GitHubIssueTrackerFactory>();
    const resolver = new IssueTrackerResolver(new IssueTrackerSecrets(new Map()), factory);

    expect(() => resolver.resolve(project("github-project", githubConfig)))
      .toThrowError(expect.objectContaining({
        code: "CREDENTIAL_UNAVAILABLE",
        provider: "github",
        projectId: "github-project",
      }));
    expect(factory).not.toHaveBeenCalled();
  });
});

class StubIssueTracker implements IssueTracker {
  public getIssue(_reference: IssueReference): Promise<IssueDetails> {
    return Promise.reject(new Error("not used"));
  }

  public listAssignedToMe(_page?: PageToken): Promise<IssuePage> {
    return Promise.reject(new Error("not used"));
  }
}

function project(
  id: string,
  issueTracker?: ProjectConfig["issueTracker"],
): ProjectConfig {
  return {
    id,
    name: id,
    path: "/tmp/project",
    allowedOperations: new Set(["task"]),
    ...(issueTracker === undefined ? {} : { issueTracker }),
  };
}
