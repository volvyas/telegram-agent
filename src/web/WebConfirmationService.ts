import { createHash, randomBytes } from "node:crypto";
import type { ActorId } from "../domain/Actor.js";
import type { WebSession } from "./WebSessionStore.js";

export interface WebConfirmation {
  readonly id: string;
  readonly actorId: ActorId;
  readonly projectId: string;
  readonly operation: string;
  readonly payloadHash: string;
  readonly securityContextId: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

export class WebConfirmationService {
  readonly #items = new Map<string, WebConfirmation>(); readonly #ttlMs: number; readonly #now: () => number;
  public constructor(options: { readonly ttlMs?: number; readonly now?: () => number } = {}) { this.#ttlMs = options.ttlMs ?? 5 * 60_000; this.#now = options.now ?? Date.now; }
  public create(session: WebSession, projectId: string, operation: string, payload: unknown): WebConfirmation {
    const now = this.#now(); this.cleanup(); const item = Object.freeze({ id: randomBytes(24).toString("base64url"), actorId: "web:operator" as const, projectId, operation, payloadHash: hashPayload(payload), securityContextId: session.securityContextId, csrfToken: session.csrfToken, createdAt: now, expiresAt: now + this.#ttlMs }); this.#items.set(item.id, item); return item;
  }
  public consume(id: string, session: WebSession, projectId: string, operation: string, payload: unknown, csrfToken: string): WebConfirmation {
    const item = this.#items.get(id); this.#items.delete(id); const now = this.#now();
    if (item === undefined || item.expiresAt <= now || item.actorId !== "web:operator" || item.projectId !== projectId || item.operation !== operation || item.payloadHash !== hashPayload(payload) || item.securityContextId !== session.securityContextId || item.csrfToken !== csrfToken) throw new Error("confirmation_invalid");
    return item;
  }
  public invalidateSession(securityContextId: string): void { for (const [id, item] of this.#items) if (item.securityContextId === securityContextId) this.#items.delete(id); }
  public cleanup(): void { const now = this.#now(); for (const [id, item] of this.#items) if (item.expiresAt <= now) this.#items.delete(id); }
}

export function hashPayload(payload: unknown): string { return createHash("sha256").update(stableJson(payload)).digest("hex"); }
function stableJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`; }
