import type { GitHubIssueTrackerConfig } from "../config/IssueTrackerConfig.js";
import type { CreatedIssueReference, IssueDraft, IssueWriter } from "./IssueWriter.js";
import { IssueTrackerError } from "./IssueTracker.js";

const ACCEPT = "application/vnd.github+json";
const MAX_RESPONSE = 64 * 1024;

export interface GitHubIssueWriterOptions { readonly fetch?: typeof globalThis.fetch; readonly userAgent?: string; }

/** GitHub's sole allowed mutation: create an issue in the configured repo. */
export class GitHubIssueWriter implements IssueWriter {
  readonly #config: GitHubIssueTrackerConfig; readonly #token: string;
  readonly #fetch: typeof globalThis.fetch; readonly #userAgent: string;
  public constructor(config: GitHubIssueTrackerConfig, token: string, options: GitHubIssueWriterOptions = {}) {
    this.#config = config; this.#token = token; this.#fetch = options.fetch ?? globalThis.fetch;
    this.#userAgent = options.userAgent ?? "telegram-agent/0.1.0";
  }
  public async createIssue(draft: IssueDraft, signal?: AbortSignal): Promise<CreatedIssueReference> {
    const base = new URL(this.#config.apiBaseUrl);
    const path = `${base.pathname.replace(/\/$/u, "")}/repos/${encodeURIComponent(this.#config.owner)}/${encodeURIComponent(this.#config.repository)}/issues`;
    const url = `${base.origin}${path}`;
    let response: Response;
    try {
      response = await this.#fetch(url, { method: "POST", headers: { Accept: ACCEPT, Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json", "X-GitHub-Api-Version": this.#config.apiVersion, "User-Agent": this.#userAgent }, body: JSON.stringify({ title: draft.summary, body: draft.description }), redirect: "manual", ...(signal === undefined ? {} : { signal }) });
    } catch (error) { if (signal?.aborted) throw new IssueTrackerError("ABORTED", "Issue creation was aborted"); throw new IssueTrackerError("UNAVAILABLE", "Issue tracker is unavailable", { cause: error }); }
    if (response.status === 401) throw new IssueTrackerError("AUTHENTICATION_FAILED", "GitHub authentication failed");
    if (response.status === 403 || response.status === 429) throw new IssueTrackerError("RATE_LIMITED", "GitHub rate limit or permission denied");
    if (response.status === 422) throw new IssueTrackerError("PROVIDER_REJECTED_QUERY", "GitHub rejected the issue");
    if (response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) throw new IssueTrackerError("ISSUE_MOVED", "GitHub redirected the request");
    if (!response.ok) throw new IssueTrackerError("UNAVAILABLE", "GitHub request failed");
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > MAX_RESPONSE) throw new IssueTrackerError("RESPONSE_TOO_LARGE", "GitHub response is too large");
    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      throw new IssueTrackerError("MALFORMED_RESPONSE", "GitHub returned an unreadable response", { cause: error });
    }
    if (new TextEncoder().encode(responseText).byteLength > MAX_RESPONSE) {
      throw new IssueTrackerError("RESPONSE_TOO_LARGE", "GitHub response is too large");
    }
    let value: unknown; try { value = JSON.parse(responseText) as unknown; } catch (error) { throw new IssueTrackerError("MALFORMED_RESPONSE", "GitHub returned invalid JSON", { cause: error }); }
    if (!isRecord(value) || !Number.isSafeInteger(value.number) || typeof value.html_url !== "string") throw new IssueTrackerError("MALFORMED_RESPONSE", "GitHub returned an invalid issue");
    const issueNumber = value.number as number;
    const webOrigin = base.hostname === "api.github.com" ? "https://github.com" : base.origin;
    const webPath = base.hostname === "api.github.com" ? "" : base.pathname.replace(/\/+$/u, "").replace(/\/api\/v3$/u, "");
    const expected = new URL(`${webOrigin}${webPath}/${this.#config.owner}/${this.#config.repository}/issues/${issueNumber}`);
    let returned: URL; try { returned = new URL(value.html_url); } catch { throw new IssueTrackerError("MALFORMED_RESPONSE", "GitHub returned an invalid issue URL"); }
    if (returned.protocol !== "https:" || returned.origin !== expected.origin || returned.pathname !== expected.pathname || returned.search || returned.hash || returned.username || returned.password) throw new IssueTrackerError("MALFORMED_RESPONSE", "GitHub returned an invalid issue URL");
    return { provider: "github", reference: `#${issueNumber}`, url: returned.toString() };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
