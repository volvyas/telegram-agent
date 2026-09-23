import { randomBytes } from "node:crypto";

import type { Confirmation, Storage } from "../storage/Storage.js";

export type ConfirmationDecision = "allow" | "deny";

export interface ConfirmationServiceOptions {
  readonly clock?: () => Date;
  readonly ttlMs?: number;
  /** Injectable for deterministic tests; production IDs must remain opaque. */
  readonly idFactory?: () => string;
}

export class ConfirmationError extends Error {
  public readonly code:
    | "CONFIRMATION_NOT_FOUND"
    | "CONFIRMATION_WRONG_USER"
    | "CONFIRMATION_WRONG_PROJECT"
    | "CONFIRMATION_EXPIRED"
    | "CONFIRMATION_INVALID";

  public constructor(
    code: ConfirmationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ConfirmationError";
    this.code = code;
  }
}

export interface ConsumeConfirmationInput {
  readonly id: string;
  readonly userId: number;
  readonly projectId: string;
  readonly decision: ConfirmationDecision;
}

/** Persistent, one-shot authorization boundary for dangerous operations. */
export class ConfirmationService {
  readonly #storage: Storage;
  readonly #clock: () => Date;
  readonly #ttlMs: number;
  readonly #idFactory: () => string;

  public constructor(storage: Storage, options: ConfirmationServiceOptions = {}) {
    this.#storage = storage;
    this.#clock = options.clock ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#idFactory = options.idFactory ?? (() => randomBytes(18).toString("base64url"));
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new RangeError("Confirmation TTL must be a positive integer");
    }
  }

  public async request(
    userId: number,
    projectId: string,
    operation: string,
  ): Promise<Confirmation> {
    validateIdentity(userId, projectId, operation);
    const now = this.#clock();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.valueOf() + this.#ttlMs).toISOString();
    let confirmation: Confirmation | undefined;
    await this.#storage.update((state) => ({
      ...state,
      confirmations: (() => {
        let id: string;
        let attempts = 0;
        do {
          id = this.#idFactory();
          attempts += 1;
          if (attempts > 100) {
            throw new ConfirmationError("CONFIRMATION_INVALID", "Unable to allocate a unique confirmation ID");
          }
        } while (state.confirmations.some((item) => item.id === id));
        if (id.length < 16 || id.length > 256) {
          throw new ConfirmationError("CONFIRMATION_INVALID", "Confirmation ID is not opaque enough");
        }
        confirmation = Object.freeze({ id, userId, projectId, operation, createdAt, expiresAt });
        return [...state.confirmations, confirmation];
      })(),
    }));
    if (confirmation === undefined) throw new Error("Confirmation creation did not complete");
    return confirmation;
  }

  /** Alias emphasizing that the returned value is a pending confirmation. */
  public create(userId: number, projectId: string, operation: string): Promise<Confirmation> {
    return this.request(userId, projectId, operation);
  }

  public requestConfirmation(userId: number, projectId: string, operation: string): Promise<Confirmation> {
    return this.request(userId, projectId, operation);
  }

  public async get(id: string): Promise<Confirmation | undefined> {
    return (await this.#storage.load()).confirmations.find((confirmation) => confirmation.id === id);
  }

  /** Removes expired authorizations during startup recovery. */
  public async expireExpired(): Promise<void> {
    const now = this.#clock().valueOf();
    await this.#storage.update((state) => {
      const confirmations = state.confirmations.filter(
        (confirmation) => new Date(confirmation.expiresAt).valueOf() > now,
      );
      return confirmations.length === state.confirmations.length
        ? state
        : { ...state, confirmations };
    });
  }

  /**
   * Validates and consumes in one serialized storage update. Ownership failures
   * leave the entry pending so the rightful user can still act on it.
   */
  public async consume(input: ConsumeConfirmationInput): Promise<ConfirmationDecision>;
  public async consume(id: string, userId: number, projectId: string, decision: ConfirmationDecision): Promise<ConfirmationDecision>;
  public async consume(
    inputOrId: ConsumeConfirmationInput | string,
    userId?: number,
    projectId?: string,
    decision?: ConfirmationDecision,
  ): Promise<ConfirmationDecision> {
    const input: ConsumeConfirmationInput = typeof inputOrId === "string"
      ? { id: inputOrId, userId: userId as number, projectId: projectId as string, decision: decision as ConfirmationDecision }
      : inputOrId;
    if (input.decision !== "allow" && input.decision !== "deny") {
      throw new ConfirmationError("CONFIRMATION_INVALID", "Confirmation decision is invalid");
    }
    let result: ConfirmationDecision | undefined;
    await this.#storage.update((state) => {
      const index = state.confirmations.findIndex((item) => item.id === input.id);
      if (index < 0) throw new ConfirmationError("CONFIRMATION_NOT_FOUND", "Confirmation is no longer pending");
      const current = state.confirmations[index];
      if (current === undefined) throw new ConfirmationError("CONFIRMATION_NOT_FOUND", "Confirmation is no longer pending");
      if (current.userId !== input.userId) throw new ConfirmationError("CONFIRMATION_WRONG_USER", "Confirmation belongs to another user");
      if (current.projectId !== input.projectId) throw new ConfirmationError("CONFIRMATION_WRONG_PROJECT", "Confirmation belongs to another project");
      if (this.#clock().valueOf() >= new Date(current.expiresAt).valueOf()) {
        return { ...state, confirmations: state.confirmations.filter((_, itemIndex) => itemIndex !== index) };
      }
      result = input.decision;
      return { ...state, confirmations: state.confirmations.filter((_, itemIndex) => itemIndex !== index) };
    });
    if (result === undefined) throw new ConfirmationError("CONFIRMATION_EXPIRED", "Confirmation has expired");
    return result;
  }

  public consumeConfirmation(input: ConsumeConfirmationInput): Promise<ConfirmationDecision> {
    return this.consume(input);
  }
}

function validateIdentity(userId: number, projectId: string, operation: string): void {
  if (!Number.isSafeInteger(userId) || userId < 0 || projectId.length === 0 || operation.length === 0) {
    throw new ConfirmationError("CONFIRMATION_INVALID", "Confirmation identity is invalid");
  }
}
