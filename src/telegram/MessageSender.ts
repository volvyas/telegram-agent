import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { withTelegramRetry, type TelegramRetryOptions } from "./TelegramRetry.js";

const TELEGRAM_MESSAGE_LIMIT = 4_096;
const DEFAULT_INLINE_DIFF_BYTES = 12 * 1024;
const DIFF_CHUNK_CHARACTERS = 3_900;
const LONG_MESSAGE_CHUNK_CHARACTERS = 3_900;
const TEMPORARY_PREFIX = "telegram-agent-diff-";
const DIFF_FILE_NAME = "changes.diff";
const TEST_OUTPUT_FILE_NAME = "test-output.txt";
const UTF8_BOM = "\uFEFF";

export interface MessageTransport {
  sendText(text: string): Promise<void>;
  sendDocument(
    path: string,
    options: { readonly filename: string; readonly caption: string },
  ): Promise<void>;
}

export interface TextMessageTransport {
  sendText(text: string): Promise<void>;
}

export interface MessageSenderOptions {
  readonly temporaryRoot?: string;
  readonly inlineDiffBytes?: number;
  readonly telegramRetry?: TelegramRetryOptions;
}

export type DiffDelivery =
  | { readonly kind: "empty" }
  | { readonly kind: "messages"; readonly count: number }
  | { readonly kind: "document" };

export type LongMessageDelivery =
  | { readonly kind: "empty" }
  | { readonly kind: "messages"; readonly count: number };

export class MessageSender {
  readonly #temporaryRoot: string;
  readonly #inlineDiffBytes: number;
  readonly #telegramRetry: TelegramRetryOptions;

  public constructor(options: MessageSenderOptions = {}) {
    this.#temporaryRoot = options.temporaryRoot ?? tmpdir();
    this.#inlineDiffBytes = options.inlineDiffBytes ?? DEFAULT_INLINE_DIFF_BYTES;
    this.#telegramRetry = options.telegramRetry ?? {};
    if (!isAbsolute(this.#temporaryRoot)) {
      throw new TypeError("Temporary root must be absolute");
    }
    if (!Number.isSafeInteger(this.#inlineDiffBytes) || this.#inlineDiffBytes <= 0) {
      throw new TypeError("Inline diff limit must be a positive integer");
    }
  }

  public async sendDiff(
    transport: MessageTransport,
    content: string,
  ): Promise<DiffDelivery> {
    if (content.length === 0) {
      await this.#sendText(transport, "No tracked changes.");
      return Object.freeze({ kind: "empty" });
    }
    if (Buffer.byteLength(content, "utf8") <= this.#inlineDiffBytes) {
      const chunks = splitText(content, DIFF_CHUNK_CHARACTERS);
      for (const [index, chunk] of chunks.entries()) {
        await this.#sendText(transport,
          `Diff (${String(index + 1)}/${String(chunks.length)}):\n${chunk}`,
        );
      }
      return Object.freeze({ kind: "messages", count: chunks.length });
    }

    const directory = await mkdtemp(join(this.#temporaryRoot, TEMPORARY_PREFIX));
    const path = join(directory, DIFF_FILE_NAME);
    try {
      await chmod(directory, 0o700);
      await writeUtf8Document(path, content);
      await this.#sendDocument(transport, path, {
        filename: DIFF_FILE_NAME,
        caption: "Git diff (UTF-8)",
      });
      return Object.freeze({ kind: "document" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** Sends bounded plain-text Telegram messages while keeping fenced blocks usable. */
  public async sendLongMessage(
    transport: TextMessageTransport,
    content: string,
  ): Promise<LongMessageDelivery> {
    if (content.length === 0) return Object.freeze({ kind: "empty" });
    const chunks = splitTextPreservingCodeFences(content, LONG_MESSAGE_CHUNK_CHARACTERS);
    for (const chunk of chunks) await this.#sendText(transport, chunk);
    return Object.freeze({ kind: "messages", count: chunks.length });
  }

  /** Delivers command output safely, using a document when it is too large. */
  public async sendTestOutput(
    transport: MessageTransport,
    content: string,
  ): Promise<DiffDelivery> {
    if (content.length === 0) return Object.freeze({ kind: "empty" });
    const directory = await mkdtemp(join(this.#temporaryRoot, TEMPORARY_PREFIX));
    const path = join(directory, TEST_OUTPUT_FILE_NAME);
    try {
      await chmod(directory, 0o700);
      await writeUtf8Document(path, content);
      await this.#sendDocument(transport, path, {
        filename: TEST_OUTPUT_FILE_NAME,
        caption: "Test diagnostics (UTF-8)",
      });
      return Object.freeze({ kind: "document" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #sendText(transport: TextMessageTransport, text: string): Promise<void> {
    await withTelegramRetry(() => transport.sendText(text), this.#telegramRetry);
  }

  async #sendDocument(
    transport: MessageTransport,
    path: string,
    options: { readonly filename: string; readonly caption: string },
  ): Promise<void> {
    await withTelegramRetry(() => transport.sendDocument(path, options), this.#telegramRetry);
  }
}

async function writeUtf8Document(path: string, content: string): Promise<void> {
  const encoded = content.startsWith(UTF8_BOM) ? content : `${UTF8_BOM}${content}`;
  await writeFile(path, encoded, { encoding: "utf8", mode: 0o600 });
}

function splitText(content: string, limit: number): readonly string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + limit, content.length);
    if (end < content.length && isLowSurrogate(content.charCodeAt(end))) {
      end -= 1;
    }
    if (end < content.length) {
      const lineEnd = content.lastIndexOf("\n", end - 1) + 1;
      if (lineEnd > start + Math.floor(limit / 2)) {
        end = lineEnd;
      }
    }
    chunks.push(content.slice(start, end));
    start = end;
  }
  return Object.freeze(chunks);
}

function splitTextPreservingCodeFences(content: string, limit: number): readonly string[] {
  const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const chunks: string[] = [];
  let current = "";
  let inFence = false;

  for (const line of lines) {
    if (line.length > limit) {
      if (current.length > 0) {
        chunks.push(current);
        current = inFence ? "```\n" : "";
      }
      for (const piece of splitText(line, limit)) chunks.push(piece);
      continue;
    }
    if (current.length > 0 && current.length + line.length > limit) {
      if (inFence && current.length + 3 <= limit) current += "\n```";
      chunks.push(current);
      current = inFence ? "```\n" : "";
    }
    current += line;
    if ((line.match(/```/gu)?.length ?? 0) % 2 === 1) inFence = !inFence;
  }
  if (current.length > 0) chunks.push(current);
  return Object.freeze(chunks);
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

export const MESSAGE_SENDER_LIMITS = Object.freeze({
  telegramMessageCharacters: TELEGRAM_MESSAGE_LIMIT,
  diffChunkCharacters: DIFF_CHUNK_CHARACTERS,
  longMessageChunkCharacters: LONG_MESSAGE_CHUNK_CHARACTERS,
  defaultInlineDiffBytes: DEFAULT_INLINE_DIFF_BYTES,
});
