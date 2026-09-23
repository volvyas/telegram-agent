export interface TelegramRetryOptions {
  readonly maxRetries?: number;
  readonly delayMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

/** Retries only rate-limit and transient Telegram failures, never arbitrary errors. */
export async function withTelegramRetry<T>(
  action: () => Promise<T>,
  options: TelegramRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const delayMs = options.delayMs ?? 250;
  const sleep = options.sleep ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  let attempt = 0;
  while (true) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableTelegramError(error)) throw error;
      const retryAfter = readRetryAfter(error);
      await sleep(retryAfter ?? delayMs * (attempt + 1));
      attempt += 1;
    }
  }
}

function isRetryableTelegramError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  const code = candidate.error_code ?? candidate.status ?? candidate.code;
  if (code === 429 || code === 408 || code === 500 || code === 502 || code === 503 || code === 504) return true;
  return typeof candidate.message === "string" && /(?:too many requests|timeout|temporarily unavailable)/iu.test(candidate.message);
}

function readRetryAfter(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const parameters = (error as Record<string, unknown>).parameters;
  if (typeof parameters !== "object" || parameters === null) return undefined;
  const retryAfter = (parameters as Record<string, unknown>).retry_after;
  return typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter >= 0
    ? retryAfter * 1_000
    : undefined;
}
