import type { IssueProvider } from "./IssueTracker.js";

export interface IssueDraft {
  readonly summary: string;
  readonly description: string;
}

export interface IssueCreationProposal {
  readonly kind: "issue_creation";
  readonly provider: IssueProvider;
  readonly projectId: string;
  readonly draft: IssueDraft;
}

export interface CreatedIssueReference {
  readonly provider: IssueProvider;
  readonly reference: string;
  readonly url: string;
}

/** The deliberately tiny mutation port. It is not part of IssueTracker. */
export interface IssueWriter {
  createIssue(draft: IssueDraft, signal?: AbortSignal): Promise<CreatedIssueReference>;
}
