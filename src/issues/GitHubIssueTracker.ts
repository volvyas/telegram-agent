import type { GitHubIssueTrackerConfig } from "../config/IssueTrackerConfig.js";
import {
  IssueTrackerError,
  type IssueDetails,
  type IssuePage,
  type IssueReference,
  type IssueTracker,
  type IssueTrackerErrorCode,
  type PageToken,
} from "./IssueTracker.js";

const ACCEPT = "application/vnd.github+json";
const USER_AGENT = "telegram-agent/0.1.0";
const SEARCH_PATH = "/search/issues";
const PAGE_TOKEN = Symbol("github-page-token");

export interface GitHubIssueTrackerOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly userAgent?: string;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

type JsonRecord = Record<string, unknown>;

interface GitHubPageToken extends PageToken {
  readonly [PAGE_TOKEN]: true;
  readonly url: string;
  readonly depth: number;
}

/** Read-only GitHub Issues adapter. Its transport surface intentionally only permits GET. */
export class GitHubIssueTracker implements IssueTracker {
  readonly #config: GitHubIssueTrackerConfig;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #userAgent: string;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  #login: string | undefined;

  public constructor(
    config: GitHubIssueTrackerConfig,
    token: string,
    options: GitHubIssueTrackerOptions = {},
  ) {
    this.#config = config;
    this.#token = token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#userAgent = options.userAgent ?? USER_AGENT;
    this.#sleep = options.sleep ?? delay;
  }

  public async getIssue(reference: IssueReference, signal?: AbortSignal): Promise<IssueDetails> {
    const number = parseIssueNumber(reference);
    const url = this.#endpoint(`/repos/${encodeURIComponent(this.#config.owner)}/${encodeURIComponent(this.#config.repository)}/issues/${number}`);
    const response = await this.#request(url, signal);
    const payload = await this.#json(response, signal);
    if (Object.hasOwn(payload, "pull_request")) {
      throw this.error("NOT_AN_ISSUE", "The requested reference is a pull request");
    }
    return this.#normalizeIssue(payload, number);
  }

  public async listAssignedToMe(page?: PageToken, signal?: AbortSignal): Promise<IssuePage> {
    const login = await this.#authenticatedLogin(signal);
    const token = page === undefined ? undefined : this.#pageToken(page);
    const url = token?.url ?? this.#searchUrl(login);
    const response = await this.#request(url, signal);
    const payload = await this.#json(response, signal);
    if (!Array.isArray(payload.items) || typeof payload.incomplete_results !== "boolean") {
      throw this.error("MALFORMED_RESPONSE", "GitHub returned an invalid issue page");
    }
    if (payload.items.length > this.#config.limits.collectionItems) {
      throw this.error("MALFORMED_RESPONSE", "GitHub returned too many issues");
    }
    const items = payload.items.map((item, index) => {
      const record = asRecord(item);
      if (Object.hasOwn(record, "pull_request")) {
        throw this.error("MALFORMED_RESPONSE", `GitHub returned an invalid issue at index ${index}`);
      }
      return this.#normalizeIssue(record, readIssueNumber(record, index));
    });
    const depth = token === undefined ? 0 : token.depth;
    const links = parseLinks(response.headers.get("link"));
    return {
      items,
      incomplete: payload.incomplete_results,
      ...(links.next === undefined ? {} : { nextPage: this.#makePageToken(links.next, depth + 1, login) }),
      ...(links.previous === undefined ? {} : { previousPage: this.#makePageToken(links.previous, depth + 1, login) }),
    };
  }

  async #authenticatedLogin(signal: AbortSignal | undefined): Promise<string> {
    if (this.#login !== undefined) return this.#login;
    const response = await this.#request(this.#endpoint("/user"), signal);
    const payload = await this.#json(response, signal);
    const login = boundedString(payload.login, 100);
    if (login === undefined) throw this.error("MALFORMED_RESPONSE", "GitHub returned an invalid user");
    this.#login = login;
    return login;
  }

  #searchUrl(login: string): string {
    const url = new URL(this.#endpoint(SEARCH_PATH));
    url.searchParams.set("q", `repo:${this.#config.owner}/${this.#config.repository} is:issue is:open assignee:${login}`);
    url.searchParams.set("sort", "updated");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", String(this.#config.pageSize));
    return url.toString();
  }

  async #request(url: string, signal?: AbortSignal): Promise<Response> {
    this.#validateUrl(url);
    const controller = new AbortController();
    const detach = connectAbort(signal, controller);
    const timer = setTimeout(() => controller.abort(), this.#config.limits.requestTimeoutMs);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let response: Response;
        try {
          response = await this.#fetch(url, {
            method: "GET",
            headers: {
              Accept: ACCEPT,
              Authorization: `Bearer ${this.#token}`,
              "X-GitHub-Api-Version": this.#config.apiVersion,
              "User-Agent": this.#userAgent,
            },
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          if (signal?.aborted) throw this.error("ABORTED", "Issue tracker request was aborted");
          if (controller.signal.aborted) throw this.error("TIMEOUT", "Issue tracker request timed out");
          throw this.error("UNAVAILABLE", "Issue tracker is unavailable", { cause: error });
        }
        if (response.status === 403 || response.status === 429) {
          const retryMs = rateLimitDelay(response.headers, this.#config.limits.rateLimitRetryDelayMs);
          if (retryMs !== undefined && attempt === 0) {
            await this.#sleep(retryMs, controller.signal);
            continue;
          }
          throw this.error(retryMs === undefined && response.status === 403 ? "FORBIDDEN" : "RATE_LIMITED", "GitHub rate limit or permission denied");
        }
        if (response.status === 401) throw this.error("AUTHENTICATION_FAILED", "GitHub authentication failed");
        if (response.status === 404) throw this.error("NOT_FOUND", "GitHub resource was not found");
        if (response.status === 301) throw this.error("ISSUE_MOVED", "GitHub issue was moved");
        if (response.status === 410) throw this.error("ISSUE_GONE", "GitHub issue is gone");
        if (response.status === 422) throw this.error("PROVIDER_REJECTED_QUERY", "GitHub rejected the request");
        if (!response.ok) throw this.error("UNAVAILABLE", "GitHub request failed");
        return response;
      }
      throw this.error("RATE_LIMITED", "GitHub rate limit exceeded");
    } finally {
      clearTimeout(timer);
      detach();
    }
  }

  async #json(response: Response, signal?: AbortSignal): Promise<JsonRecord> {
    const limit = this.#config.limits.responseBodyBytes;
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > limit) throw this.error("RESPONSE_TOO_LARGE", "GitHub response is too large");
    try {
      const reader = response.body?.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      if (reader !== undefined) {
        for (;;) {
          const part = await readChunk(reader, this.#config.limits.requestTimeoutMs, signal);
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > limit) {
            await reader.cancel();
            throw this.error("RESPONSE_TOO_LARGE", "GitHub response is too large");
          }
          chunks.push(part.value);
        }
      } else {
        const buffer = new Uint8Array(await withTimeout(response.arrayBuffer(), this.#config.limits.requestTimeoutMs, signal));
        if (buffer.byteLength > limit) throw this.error("RESPONSE_TOO_LARGE", "GitHub response is too large");
        chunks.push(buffer);
      }
      if (signal?.aborted) throw this.error("ABORTED", "Issue tracker request was aborted");
      const body = new TextDecoder().decode(concat(chunks, bytes));
      let value: unknown;
      try { value = JSON.parse(body) as unknown; } catch (error) { throw this.error("MALFORMED_RESPONSE", "GitHub returned invalid JSON", { cause: error }); }
      return asRecord(value);
    } catch (error) {
      if (error instanceof IssueTrackerError) throw error;
      if (signal?.aborted) throw this.error("ABORTED", "Issue tracker request was aborted");
      throw this.error("UNAVAILABLE", "Unable to read GitHub response", { cause: error });
    }
  }

  #normalizeIssue(value: JsonRecord, number: number): IssueDetails {
    const title = boundedString(value.title, this.#config.limits.issueTitleCodePoints);
    const state = boundedString(value.state, 32);
    if (value.number !== undefined && (typeof value.number !== "number" || value.number !== number)) {
      throw this.error("MALFORMED_RESPONSE", "GitHub returned an issue with an unexpected number");
    }
    const url = this.#issueUrl(value.html_url, number);
    const createdAt = boundedString(value.created_at, 64);
    const updatedAt = boundedString(value.updated_at, 64);
    if (title === undefined || state === undefined || (value.html_url !== undefined && url === undefined) || createdAt === undefined || updatedAt === undefined) {
      throw this.error("MALFORMED_RESPONSE", "GitHub returned an invalid issue");
    }
    const author = value.user === null || value.user === undefined ? undefined : boundedString(asRecord(value.user).login, 100);
    const assignees = value.assignees === undefined || value.assignees === null ? [] : readValues(value.assignees, this.#config.limits.collectionItems, this.#config.limits.collectionValueCodePoints);
    const labels = value.labels === undefined || value.labels === null ? [] : readValues(value.labels, this.#config.limits.collectionItems, this.#config.limits.collectionValueCodePoints);
    const milestone = value.milestone === null || value.milestone === undefined ? undefined : boundedString(asRecord(value.milestone).title, this.#config.limits.collectionValueCodePoints);
    const body = value.body === null || value.body === undefined ? undefined : boundedMarkdown(value.body, this.#config.limits.issueBodyCodePoints);
    if (author === undefined && value.user !== null && value.user !== undefined || assignees === undefined || labels === undefined || milestone === undefined && value.milestone !== null && value.milestone !== undefined || body === undefined && value.body !== null && value.body !== undefined) {
      throw this.error("MALFORMED_RESPONSE", "GitHub returned an invalid issue");
    }
    const stateReason = value.state_reason === null || value.state_reason === undefined ? undefined : boundedString(value.state_reason, 32);
    return {
      provider: "github", reference: `#${number}`, repository: `${this.#config.owner}/${this.#config.repository}`,
      title, state, ...(url === undefined ? {} : { url }), ...(author === undefined ? {} : { author }), assignees: assignees ?? [], labels: labels ?? [],
      ...(milestone === undefined ? {} : { milestone }), ...(body === undefined ? {} : { body }), createdAt, updatedAt,
      ...(value.closed_at === null || value.closed_at === undefined ? {} : { closedAt: requireString(value.closed_at, "closed_at") }),
      metadata: stateReason === undefined ? {} : { stateReason },
    };
  }

  #endpoint(path: string): string {
    const base = new URL(this.#config.apiBaseUrl);
    const basePath = normalizeBasePath(base.pathname);
    return `${base.origin}${basePath}${path}`;
  }
  #issueUrl(value: unknown, number: number): string | undefined {
    try {
      const url = new URL(String(value));
      const api = new URL(this.#config.apiBaseUrl);
      const webOrigin = api.hostname === "api.github.com" ? "https://github.com" : api.origin;
      const expectedPath = `/${this.#config.owner}/${this.#config.repository}/issues/${number}`;
      return url.protocol === "https:" && url.origin === webOrigin && url.pathname === expectedPath && !url.username && !url.password && !url.hash ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }
  #makePageToken(url: string, depth: number, login: string): GitHubPageToken {
    if (depth > this.#config.limits.paginationDepth) throw this.error("MALFORMED_RESPONSE", "GitHub pagination depth exceeded");
    this.#validatePaginationUrl(url, login);
    return { [PAGE_TOKEN]: true, url, depth } as GitHubPageToken;
  }
  #pageToken(value: PageToken): GitHubPageToken {
    if (!(PAGE_TOKEN in (value as object))) throw this.error("INVALID_REFERENCE", "Invalid issue page token");
    const token = value as GitHubPageToken;
    return token;
  }
  #validateUrl(value: string): void {
    let url: URL;
    try { url = new URL(value); } catch { throw this.error("MALFORMED_RESPONSE", "GitHub pagination link is invalid"); }
    const base = new URL(this.#config.apiBaseUrl);
    const basePath = normalizeBasePath(base.pathname);
    if (url.origin !== base.origin || url.protocol !== "https:" || url.username || url.password || url.hash || (url.pathname !== `${basePath}${SEARCH_PATH}` && url.pathname !== `${basePath}/user` && !url.pathname.startsWith(`${basePath}/repos/`))) {
      throw this.error("MALFORMED_RESPONSE", "GitHub pagination link is not allowed");
    }
  }
  #validatePaginationUrl(value: string, login: string): void {
    this.#validateUrl(value);
    const url = new URL(value);
    const base = new URL(this.#config.apiBaseUrl);
    const expected = new URL(this.#searchUrl(login));
    const basePath = normalizeBasePath(base.pathname);
    if (url.pathname !== `${basePath}${SEARCH_PATH}` || url.hash || url.username || url.password || url.searchParams.get("q") !== expected.searchParams.get("q") || url.searchParams.get("sort") !== "updated" || url.searchParams.get("order") !== "desc" || url.searchParams.get("per_page") !== String(this.#config.pageSize)) {
      throw this.error("MALFORMED_RESPONSE", "GitHub pagination link is not allowed");
    }
    for (const key of url.searchParams.keys()) {
      if (!["q", "sort", "order", "per_page", "page", "after", "before"].includes(key)) throw this.error("MALFORMED_RESPONSE", "GitHub pagination link is not allowed");
    }
  }
  error(code: IssueTrackerErrorCode, message: string, options?: ErrorOptions): IssueTrackerError { return new IssueTrackerError(code, message, { ...options, provider: "github" }); }
}

function normalizeBasePath(pathname: string): string {
  return pathname === "/" ? "" : pathname.replace(/\/+$/u, "");
}

function parseIssueNumber(reference: string): number {
  if (!/^#?\d{1,9}$/u.test(reference) || Number(reference.replace("#", "")) < 1) throw new IssueTrackerError("INVALID_REFERENCE", "Issue reference is invalid", { provider: "github" });
  return Number(reference.replace("#", ""));
}
function asRecord(value: unknown): JsonRecord { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new IssueTrackerError("MALFORMED_RESPONSE", "GitHub returned an invalid response", { provider: "github" }); return value as JsonRecord; }
function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || [...value].length > max) return undefined;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return undefined;
  }
  return value;
}
function boundedMarkdown(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || [...value].length > max) return undefined;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && ((code <= 0x1f && code !== 9 && code !== 10 && code !== 13) || code === 0x7f)) return undefined;
  }
  return value;
}
function requireString(value: unknown, field: string): string { const result = boundedString(value, 64); if (result === undefined) throw new IssueTrackerError("MALFORMED_RESPONSE", `GitHub returned an invalid ${field}`, { provider: "github" }); return result; }
function readIssueNumber(value: JsonRecord, index: number): number { const number = value.number; if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new IssueTrackerError("MALFORMED_RESPONSE", `GitHub returned an invalid issue at index ${index}`, { provider: "github" }); return number; }
function readValues(value: unknown, maxItems: number, maxLength: number): string[] | undefined { if (!Array.isArray(value) || value.length > maxItems) return undefined; const result: string[] = []; for (const item of value) { const name = boundedString(asRecord(item).name ?? asRecord(item).login, maxLength); if (name === undefined) return undefined; result.push(name); } return result; }
function parseLinks(value: string | null): { next?: string; previous?: string } { const result: { next?: string; previous?: string } = {}; for (const part of value?.split(",") ?? []) { const match = /<([^>]+)>;\s*rel="([^"]+)"/u.exec(part); if (match?.[1] !== undefined && (match[2] === "next" || match[2] === "prev")) result[match[2] === "next" ? "next" : "previous"] = match[1]; } return result; }
function rateLimitDelay(headers: Headers, cap: number): number | undefined { const retry = Number(headers.get("retry-after")); if (Number.isFinite(retry) && retry >= 0 && retry * 1000 <= cap) return retry * 1000; const reset = Number(headers.get("x-ratelimit-reset")); if (Number.isFinite(reset)) { const delay = Math.max(0, reset * 1000 - Date.now()); if (delay <= cap) return delay; } return undefined; }
function concat(chunks: readonly Uint8Array[], length: number): Uint8Array { const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result; }
function connectAbort(signal: AbortSignal | undefined, controller: AbortController): () => void { if (signal === undefined) return () => undefined; if (signal.aborted) controller.abort(); const listener = () => controller.abort(); signal.addEventListener("abort", listener, { once: true }); return () => signal.removeEventListener("abort", listener); }
function delay(milliseconds: number, signal: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new IssueTrackerError("ABORTED", "Issue tracker request was aborted", { provider: "github" })); }, { once: true }); }); }
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number, signal: AbortSignal | undefined): Promise<Awaited<ReturnType<typeof reader.read>>> {
  return withTimeout(reader.read(), timeoutMs, signal);
}
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IssueTrackerError("TIMEOUT", "Issue tracker request timed out", { provider: "github" })), timeoutMs);
    if (signal !== undefined) {
      abort = () => reject(new IssueTrackerError("ABORTED", "Issue tracker request was aborted", { provider: "github" }));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined && signal !== undefined) signal.removeEventListener("abort", abort);
  }
}
