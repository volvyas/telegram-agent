import { describe, expect, it, vi } from "vitest";

import { GitHubIssueTracker } from "../../src/issues/GitHubIssueTracker.js";
import type { GitHubIssueTrackerConfig } from "../../src/config/IssueTrackerConfig.js";
import { createIssueReference } from "../../src/issues/IssueTracker.js";

const limits: GitHubIssueTrackerConfig["limits"] = {
  requestTimeoutMs: 1_000,
  responseBodyBytes: 100_000,
  issueTitleCodePoints: 512,
  issueBodyCodePoints: 12_000,
  collectionItems: 50,
  collectionValueCodePoints: 100,
  paginationDepth: 10,
  rateLimitRetryDelayMs: 3_000,
};

function config(apiBaseUrl: string): GitHubIssueTrackerConfig {
  return {
    type: "github",
    owner: "octocat",
    repository: "hello-world",
    tokenEnv: "GITHUB_TOKEN",
    apiBaseUrl,
    apiVersion: "2026-03-10",
    pageSize: 10,
    limits,
  };
}

function issue(number: number): Record<string, unknown> {
  return {
    number,
    title: "An issue",
    state: "open",
    html_url: `https://github.com/octocat/hello-world/issues/${number}`,
    created_at: "2026-09-30T10:00:00.000Z",
    updated_at: "2026-09-30T10:00:00.000Z",
    user: { login: "octocat" },
    assignees: [],
    labels: [],
    milestone: null,
    body: null,
  };
}

function response(payload: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    ...(headers === undefined ? {} : { headers }),
  });
}

describe("GitHubIssueTracker endpoint allowlist", () => {
  it.each([
    ["https://api.github.com", "https://api.github.com"],
    ["https://api.github.com/", "https://api.github.com"],
    ["https://github.example/api/v3", "https://github.example/api/v3"],
    ["https://github.example/api/v3/", "https://github.example/api/v3"],
  ])("allows %s without introducing a double slash", async (apiBaseUrl, expectedBase) => {
    const payload = issue(42);
    if (apiBaseUrl.includes("github.example")) {
      payload.html_url = "https://github.example/octocat/hello-world/issues/42";
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload));
    const tracker = new GitHubIssueTracker(config(apiBaseUrl), "secret", { fetch });

    await tracker.getIssue(createIssueReference("#42"));

    expect(fetch).toHaveBeenCalledWith(
      `${expectedBase}/repos/octocat/hello-world/issues/42`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("allows root-base user, assigned-search, direct lookup, and pagination paths", async () => {
    const next = "https://api.github.com/search/issues?q=repo%3Aoctocat%2Fhello-world+is%3Aissue+is%3Aopen+assignee%3Aoctocat&sort=updated&order=desc&per_page=10&page=2";
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ login: "octocat" }))
      .mockResolvedValueOnce(response({ items: [issue(42)], incomplete_results: false }, { link: `<${next}>; rel="next"` }))
      .mockResolvedValueOnce(response({ items: [], incomplete_results: false }));
    const tracker = new GitHubIssueTracker(config("https://api.github.com"), "secret", { fetch });

    const firstPage = await tracker.listAssignedToMe();
    await tracker.listAssignedToMe(firstPage.nextPage);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/user",
      expect.stringMatching(/^https:\/\/api\.github\.com\/search\/issues\?/),
      next,
    ]);
  });

  it("accepts Markdown newlines in an issue body while rejecting other controls", async () => {
    const payload = issue(42);
    payload.body = "## Context\n\nObserved behavior\n\nExpected behavior";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload));
    const tracker = new GitHubIssueTracker(config("https://api.github.com"), "secret", { fetch });

    await expect(tracker.getIssue(createIssueReference("42"))).resolves.toMatchObject({
      body: payload.body,
    });

    fetch.mockResolvedValue(response({ ...payload, body: "safe\u0000body" }));
    await expect(tracker.getIssue(createIssueReference("42"))).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });
});
