import { randomBytes, timingSafeEqual } from "node:crypto";

export interface WebSession {
  readonly id: string;
  readonly securityContextId: string;
  readonly csrfToken: string;
  readonly createdAt: number;
  lastSeenAt: number;
}

export interface WebSessionStoreOptions { readonly idleTtlMs?: number; readonly absoluteTtlMs?: number; readonly maxSessions?: number; readonly now?: () => number; }

export class WebSessionStore {
  readonly #idleTtlMs: number; readonly #absoluteTtlMs: number; readonly #maxSessions: number; readonly #now: () => number;
  readonly #sessions = new Map<string, WebSession>();
  public constructor(options: WebSessionStoreOptions = {}) {
    this.#idleTtlMs = options.idleTtlMs ?? 30 * 60_000; this.#absoluteTtlMs = options.absoluteTtlMs ?? 8 * 60 * 60_000; this.#maxSessions = options.maxSessions ?? 128; this.#now = options.now ?? Date.now;
    if (![this.#idleTtlMs, this.#absoluteTtlMs, this.#maxSessions].every((n) => Number.isSafeInteger(n) && n > 0)) throw new RangeError("Invalid Web session limits");
  }
  public create(): WebSession {
    this.cleanup();
    if (this.#sessions.size >= this.#maxSessions) throw new Error("Web session limit reached");
    const now = this.#now(); const session = { id: randomBytes(32).toString("base64url"), securityContextId: randomBytes(24).toString("base64url"), csrfToken: randomBytes(32).toString("base64url"), createdAt: now, lastSeenAt: now };
    this.#sessions.set(session.id, session); return session;
  }
  public get(id: string): WebSession | undefined {
    const session = [...this.#sessions.values()].find((candidate) => candidate.id.length === id.length && timingSafeEqual(Buffer.from(candidate.id), Buffer.from(id)));
    if (session === undefined || this.#now() - session.lastSeenAt > this.#idleTtlMs || this.#now() - session.createdAt > this.#absoluteTtlMs) { if (session) this.#sessions.delete(session.id); return undefined; }
    session.lastSeenAt = this.#now(); return session;
  }
  public revoke(id: string): void { this.#sessions.delete(id); }
  public revokeAll(): void { this.#sessions.clear(); }
  public cleanup(): void { for (const session of this.#sessions.values()) if (this.#now() - session.lastSeenAt > this.#idleTtlMs || this.#now() - session.createdAt > this.#absoluteTtlMs) this.#sessions.delete(session.id); }
  public get size(): number { return this.#sessions.size; }
}
