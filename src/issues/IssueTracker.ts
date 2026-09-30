export const ISSUE_PROVIDERS = ["github", "jira"] as const;

export type IssueProvider = (typeof ISSUE_PROVIDERS)[number];

declare const issueReferenceBrand: unique symbol;
declare const pageTokenBrand: unique symbol;

/** Provider-neutral, bounded reference supplied by an authenticated caller. */
export type IssueReference = string & { readonly [issueReferenceBrand]: true };

/** Opaque adapter-owned pagination state. Callers may only pass it back. */
export interface PageToken {
  readonly [pageTokenBrand]: true;
}

export interface IssueDetails {
  readonly provider: IssueProvider;
  readonly reference: string;
  readonly repository?: string;
  readonly title: string;
  readonly state: string;
  readonly url?: string;
  readonly author?: string;
  readonly assignees: readonly string[];
  readonly labels: readonly string[];
  readonly milestone?: string;
  readonly body?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt?: string;
  /** Provider-specific allowlisted scalar values only, never raw response data. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface IssuePage {
  readonly items: readonly IssueDetails[];
  readonly nextPage?: PageToken;
  readonly previousPage?: PageToken;
  readonly incomplete: boolean;
}

export type IssueTrackerErrorCode =
  | "INVALID_REFERENCE"
  | "NOT_CONFIGURED"
  | "UNSUPPORTED_PROVIDER"
  | "CREDENTIAL_UNAVAILABLE"
  | "AUTHENTICATION_FAILED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "ISSUE_MOVED"
  | "ISSUE_GONE"
  | "NOT_AN_ISSUE"
  | "PROVIDER_REJECTED_QUERY"
  | "TIMEOUT"
  | "ABORTED"
  | "UNAVAILABLE"
  | "MALFORMED_RESPONSE"
  | "RESPONSE_TOO_LARGE";

/** Safe domain failure; provider payloads, URLs, queries, and credentials are excluded. */
export class IssueTrackerError extends Error {
  public readonly code: IssueTrackerErrorCode;
  public readonly provider?: IssueProvider;
  public readonly projectId?: string;

  public constructor(
    code: IssueTrackerErrorCode,
    message: string,
    options?: ErrorOptions & {
      readonly provider?: IssueProvider;
      readonly projectId?: string;
    },
  ) {
    super(message, options);
    this.name = "IssueTrackerError";
    this.code = code;
    if (options?.provider !== undefined) this.provider = options.provider;
    if (options?.projectId !== undefined) this.projectId = options.projectId;
  }
}

/**
 * Creates only a generic bounded reference. Provider-specific syntax is
 * validated by the handler/adapter that owns that provider.
 */
export function createIssueReference(value: string): IssueReference {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    hasControlCharacter(normalized)
  ) {
    throw new IssueTrackerError("INVALID_REFERENCE", "Issue reference is invalid");
  }
  return normalized as IssueReference;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

/** Read-only provider-neutral tracker boundary. */
export interface IssueTracker {
  getIssue(reference: IssueReference, signal?: AbortSignal): Promise<IssueDetails>;
  listAssignedToMe(page?: PageToken, signal?: AbortSignal): Promise<IssuePage>;
}
