import { describe, expect, it } from "vitest";

import {
  createIssueReference,
  IssueTrackerError,
  type IssueDetails,
  type IssuePage,
  type IssueReference,
  type IssueTracker,
  type PageToken,
} from "../../src/issues/IssueTracker.js";
import { defineIssueTrackerContract } from "./IssueTracker.contract.js";

const issue = Object.freeze({
  provider: "github",
  reference: "#42",
  repository: "example/service",
  title: "Keep the tracker contract read-only",
  state: "open",
  url: "https://github.example/example/service/issues/42",
  author: "octocat",
  assignees: Object.freeze(["developer"]),
  labels: Object.freeze(["bug"]),
  milestone: "MVP",
  body: "Normalized plain Markdown.",
  createdAt: "2026-09-29T10:00:00.000Z",
  updatedAt: "2026-09-30T10:00:00.000Z",
  metadata: Object.freeze({ stateReason: "reopened" }),
} satisfies IssueDetails);

const token = Object.freeze({}) as PageToken;
const page = Object.freeze({
  items: Object.freeze([issue]),
  nextPage: token,
  incomplete: false,
} satisfies IssuePage);

class FakeIssueTracker implements IssueTracker {
  public readonly getIssueCalls: unknown[] = [];
  public readonly listCalls: unknown[] = [];

  public getIssue(
    reference: IssueReference,
    signal?: AbortSignal,
  ): Promise<IssueDetails> {
    this.getIssueCalls.push(reference, signal);
    return Promise.resolve(issue);
  }

  public listAssignedToMe(
    requestedPage?: PageToken,
    signal?: AbortSignal,
  ): Promise<IssuePage> {
    this.listCalls.push(requestedPage, signal);
    return Promise.resolve(page);
  }
}

defineIssueTrackerContract("Fake", () => {
  const tracker = new FakeIssueTracker();
  return {
    tracker,
    expectedIssue: issue,
    expectedPage: page,
    pageToken: token,
    calls: {
      getIssue: tracker.getIssueCalls,
      listAssignedToMe: tracker.listCalls,
    },
  };
});

describe("IssueTracker domain contract", () => {
  it("normalizes a bounded generic reference", () => {
    expect(createIssueReference("  GH-42 ")).toBe("GH-42");
  });

  it.each(["", "   ", "bad\0reference", "bad\nreference", "x".repeat(129)])(
    "rejects an invalid reference without echoing it",
    (value) => {
      expect(() => createIssueReference(value)).toThrowError(
        expect.objectContaining({ code: "INVALID_REFERENCE" }),
      );
      try {
        createIssueReference(value);
      } catch (error) {
        expect(error).toBeInstanceOf(IssueTrackerError);
        if (value.length > 0) {
          expect((error as Error).message).not.toContain(value);
        }
      }
    },
  );

  it("contains only the two read operations in its compile-time surface", () => {
    const methods: Record<keyof IssueTracker, true> = {
      getIssue: true,
      listAssignedToMe: true,
    };

    expect(Object.keys(methods).sort()).toEqual(["getIssue", "listAssignedToMe"]);
  });
});
