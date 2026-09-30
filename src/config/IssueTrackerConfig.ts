export const GITHUB_DEFAULT_API_BASE_URL = "https://api.github.com";
export const GITHUB_DEFAULT_PAGE_SIZE = 10;
export const GITHUB_MAX_PAGE_SIZE = 50;

/** Adapter-owned safety ceilings. They cannot be relaxed from projects.json. */
export interface GitHubIssueTrackerLimits {
  readonly requestTimeoutMs: number;
  readonly responseBodyBytes: number;
  readonly issueTitleCodePoints: number;
  readonly issueBodyCodePoints: number;
  readonly collectionItems: number;
  readonly collectionValueCodePoints: number;
  readonly paginationDepth: number;
  readonly rateLimitRetryDelayMs: number;
}

export const GITHUB_ISSUE_TRACKER_LIMITS: GitHubIssueTrackerLimits = Object.freeze({
  requestTimeoutMs: 10_000,
  responseBodyBytes: 1_048_576,
  issueTitleCodePoints: 512,
  issueBodyCodePoints: 12_000,
  collectionItems: 50,
  collectionValueCodePoints: 100,
  paginationDepth: 10,
  rateLimitRetryDelayMs: 3_000,
});

export interface GitHubIssueTrackerConfig {
  readonly type: "github";
  readonly owner: string;
  readonly repository: string;
  /** Name of the environment variable containing the credential, never its value. */
  readonly tokenEnv: string;
  /** Separate opt-in mutation credential; never falls back to tokenEnv. */
  readonly writeTokenEnv?: string;
  readonly apiBaseUrl: string;
  readonly apiVersion: string;
  readonly pageSize: number;
  /** Explicit opt-in; read-only remains the default. */
  readonly allowCreation?: boolean;
  readonly limits: GitHubIssueTrackerLimits;
}

/** Reserved so configuration can be deployed before the Jira adapter exists. */
export interface JiraIssueTrackerConfig {
  readonly type: "jira";
}

export type IssueTrackerConfig = GitHubIssueTrackerConfig | JiraIssueTrackerConfig;

/**
 * Runtime-only credentials. Private fields make the store serialize as `{}` and
 * keep secret values out of ProjectConfig and persisted application state.
 */
export class IssueTrackerSecrets {
  readonly #githubTokens: ReadonlyMap<string, string>;
  readonly #githubWriteTokens: ReadonlyMap<string, string>;
  readonly #redactionValues: readonly string[];

  public constructor(
    githubTokens: ReadonlyMap<string, string>,
    githubWriteTokens: ReadonlyMap<string, string> = new Map(),
  ) {
    this.#githubTokens = new Map(githubTokens);
    this.#githubWriteTokens = new Map(githubWriteTokens);
    this.#redactionValues = Object.freeze([...new Set([...githubTokens.values(), ...githubWriteTokens.values()])]);
    Object.freeze(this);
  }

  public getGitHubToken(projectId: string): string | undefined {
    return this.#githubTokens.get(projectId);
  }

  public getGitHubWriteToken(projectId: string): string | undefined {
    return this.#githubWriteTokens.get(projectId);
  }

  public redactionValues(): readonly string[] {
    return this.#redactionValues;
  }

  public toJSON(): Record<string, never> {
    return {};
  }
}
