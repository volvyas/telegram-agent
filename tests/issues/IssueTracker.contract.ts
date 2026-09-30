import { describe, expect, it } from "vitest";

import {
  createIssueReference,
  type IssueDetails,
  type IssuePage,
  type IssueTracker,
  type PageToken,
} from "../../src/issues/IssueTracker.js";

export interface IssueTrackerContractHarness {
  readonly tracker: IssueTracker;
  readonly expectedIssue: IssueDetails;
  readonly expectedPage: IssuePage;
  readonly pageToken: PageToken;
  readonly calls: {
    readonly getIssue: readonly unknown[];
    readonly listAssignedToMe: readonly unknown[];
  };
}

/** Reusable behavioral contract for every IssueTracker implementation. */
export function defineIssueTrackerContract(
  name: string,
  createHarness: () => IssueTrackerContractHarness,
): void {
  describe(`${name} IssueTracker contract`, () => {
    it("gets a normalized issue by reference and forwards cancellation", async () => {
      const harness = createHarness();
      const reference = createIssueReference("  #42  ");
      const controller = new AbortController();

      await expect(harness.tracker.getIssue(reference, controller.signal))
        .resolves.toEqual(harness.expectedIssue);
      expect(harness.calls.getIssue).toEqual([reference, controller.signal]);
    });

    it("lists assigned issues with opaque pagination and forwards cancellation", async () => {
      const harness = createHarness();
      const controller = new AbortController();

      await expect(
        harness.tracker.listAssignedToMe(harness.pageToken, controller.signal),
      ).resolves.toEqual(harness.expectedPage);
      expect(harness.calls.listAssignedToMe).toEqual([
        harness.pageToken,
        controller.signal,
      ]);
    });
  });
}
