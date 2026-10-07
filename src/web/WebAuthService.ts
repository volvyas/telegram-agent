import type { WebSession, WebSessionStore } from "./WebSessionStore.js";
import { PasswordVerifier } from "./PasswordVerifier.js";

export interface WebAuthResult { readonly ok: boolean; readonly session?: WebSession; readonly retryAfterMs?: number; }
interface Counter { failures: number; nextAllowedAt: number; }

export class WebAuthService {
  readonly #verifier: PasswordVerifier; readonly #sessions: WebSessionStore; readonly #hash: string; readonly #now: () => number;
  readonly #sources = new Map<string, Counter>(); readonly #global: Counter = { failures: 0, nextAllowedAt: 0 };
  readonly #maxConcurrent: number; #active = 0;
  public constructor(hash: string, sessions: WebSessionStore, options: { readonly verifier?: PasswordVerifier; readonly now?: () => number; readonly maxConcurrent?: number } = {}) {
    this.#hash = hash; this.#sessions = sessions; this.#verifier = options.verifier ?? new PasswordVerifier(); this.#now = options.now ?? Date.now; this.#maxConcurrent = options.maxConcurrent ?? 4;
  }
  public async login(source: string, password: string): Promise<WebAuthResult> {
    const now = this.#now(); const sourceState = this.#sources.get(source) ?? { failures: 0, nextAllowedAt: 0 };
    if (now < sourceState.nextAllowedAt || now < this.#global.nextAllowedAt || this.#active >= this.#maxConcurrent) return { ok: false, retryAfterMs: Math.max(sourceState.nextAllowedAt, this.#global.nextAllowedAt) - now };
    this.#active += 1;
    try {
      const ok = await this.#verifier.verify(typeof password === "string" ? password : "", this.#hash);
      if (!ok) { sourceState.failures += 1; sourceState.nextAllowedAt = now + Math.min(30_000, 250 * 2 ** Math.min(sourceState.failures, 7)); this.#global.failures += 1; this.#global.nextAllowedAt = now + Math.min(5_000, 100 * 2 ** Math.min(this.#global.failures, 6)); this.#sources.set(source, sourceState); return { ok: false }; }
      this.#sources.delete(source); this.#global.failures = 0; this.#global.nextAllowedAt = 0; return { ok: true, session: this.#sessions.create() };
    } finally { this.#active -= 1; }
  }
  public logout(sessionId: string): void { this.#sessions.revoke(sessionId); }
  public session(sessionId: string): WebSession | undefined { return this.#sessions.get(sessionId); }
  public revokeAll(): void { this.#sessions.revokeAll(); }
}

export function sessionCookie(sessionId: string, secure = true): string { const name = secure ? "__Host-codex_session" : "codex_session"; return `${name}=${sessionId}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`; }
export const CLEAR_SESSION_HEADERS = Object.freeze({ "Cache-Control": "no-store", "Clear-Site-Data": '"cache", "cookies", "storage"' });
