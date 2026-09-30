import { randomUUID } from "node:crypto";

export class GatewayError extends Error {
  public readonly code: string;
  public readonly diagnosticId: string;

  public constructor(code: string, message: string, options?: ErrorOptions & { readonly diagnosticId?: string }) {
    super(message, options);
    this.name = "GatewayError";
    this.code = code;
    this.diagnosticId = options?.diagnosticId ?? createDiagnosticId();
  }
}

export function createDiagnosticId(): string {
  return `ERR-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** Formats an error for Telegram without exposing causes, tokens, paths, or stack traces. */
export function formatTelegramError(error: unknown, fallback: string): string {
  const diagnosticId = error instanceof GatewayError ? error.diagnosticId : createDiagnosticId();
  return `${fallback} Reference: ${diagnosticId}.`;
}
