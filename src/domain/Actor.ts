/** Canonical identity shared by every transport. Never accept this from a client. */
export type ActorId = `telegram:${number}` | "web:operator";

export interface ActorContext {
  readonly actorId: ActorId;
  /** Process-local security context; required for browser-sensitive actions. */
  readonly securityContextId?: string;
  readonly origin: "telegram" | "web";
}

export function telegramActorId(userId: number): ActorId {
  if (!Number.isSafeInteger(userId) || userId < 0) throw new TypeError("Invalid Telegram actor ID");
  return `telegram:${String(userId)}` as ActorId;
}

export function parseActorId(value: unknown): ActorId | undefined {
  if (typeof value !== "string") return undefined;
  if (/^telegram:[0-9]+$/u.test(value) || value === "web:operator") return value as ActorId;
  return undefined;
}

export function actorIdFromLegacyUserId(userId: number | undefined): ActorId | undefined {
  return userId === undefined ? undefined : telegramActorId(userId);
}
