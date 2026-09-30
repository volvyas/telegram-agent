import type { LogLevel } from "../config/AppConfig.js";

export interface StructuredLogFields {
  readonly [key: string]: unknown;
}

export interface StructuredLoggerOptions {
  readonly level?: LogLevel;
  readonly secrets?: readonly string[];
  readonly clock?: () => Date;
  readonly sink?: (line: string) => void;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const SENSITIVE_KEY = /(?:token|secret|password|authorization|credential|cookie|api[_-]?key|codexhome|threadid|sessionid)/iu;
const PATH_KEY = /(?:path|cwd|directory)$/iu;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_FIELD_DEPTH = 4;

/** JSON-lines logger that never emits configured secrets or sensitive path fields. */
export class StructuredLogger {
  readonly #level: LogLevel;
  readonly #secrets: readonly string[];
  readonly #clock: () => Date;
  readonly #sink: (line: string) => void;

  public constructor(options: StructuredLoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#secrets = Object.freeze((options.secrets ?? []).filter((secret) => secret.length > 0));
    this.#clock = options.clock ?? (() => new Date());
    this.#sink = options.sink ?? ((line) => console.error(line));
  }

  public debug(message: string, fields?: StructuredLogFields): void {
    this.#write("debug", message, fields);
  }

  public info(message: string, fields?: StructuredLogFields): void {
    this.#write("info", message, fields);
  }

  public warn(message: string, fields?: StructuredLogFields): void {
    this.#write("warn", message, fields);
  }

  public error(message: string, fields?: StructuredLogFields): void {
    this.#write("error", message, fields);
  }

  #write(level: LogLevel, message: string, fields: StructuredLogFields | undefined): void {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(this.#level)) return;
    const entry = {
      timestamp: this.#clock().toISOString(),
      level,
      message: this.#redactString(message).slice(0, MAX_MESSAGE_LENGTH),
      ...(fields === undefined ? {} : { fields: redactValue(fields, this.#secrets, 0) }),
    };
    this.#sink(JSON.stringify(entry));
  }

  #redactString(value: string): string {
    return this.#secrets.reduce(
      (current, secret) => current.split(secret).join("[REDACTED]"),
      value,
    );
  }
}

function redactValue(value: unknown, secrets: readonly string[], depth: number): unknown {
  if (depth > MAX_FIELD_DEPTH) return "[DEPTH_LIMIT]";
  if (typeof value === "string") {
    return secrets.reduce((current, secret) => current.split(secret).join("[REDACTED]"), value).slice(0, MAX_MESSAGE_LENGTH);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return redactValue({ name: value.name, message: value.message, code: "code" in value ? value.code : undefined }, secrets, depth + 1);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, secrets, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) result[key] = "[REDACTED]";
      else if (PATH_KEY.test(key)) result[key] = "[PATH_REDACTED]";
      else result[key] = redactValue(child, secrets, depth + 1);
    }
    return result;
  }
  return String(value);
}
