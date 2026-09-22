import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const TELEGRAM_MESSAGE_LIMIT = 4_096;
const DEFAULT_INLINE_DIFF_BYTES = 12 * 1024;
const DIFF_CHUNK_CHARACTERS = 3_900;
const TEMPORARY_PREFIX = "telegram-agent-diff-";
const DIFF_FILE_NAME = "changes.diff";
const TEST_OUTPUT_FILE_NAME = "test-output.txt";

export interface MessageTransport {
  sendText(text: string): Promise<void>;
  sendDocument(
    path: string,
    options: { readonly filename: string; readonly caption: string },
  ): Promise<void>;
}

export interface MessageSenderOptions {
  readonly temporaryRoot?: string;
  readonly inlineDiffBytes?: number;
}

export type DiffDelivery =
  | { readonly kind: "empty" }
  | { readonly kind: "messages"; readonly count: number }
  | { readonly kind: "document" };

export class MessageSender {
  readonly #temporaryRoot: string;
  readonly #inlineDiffBytes: number;

  public constructor(options: MessageSenderOptions = {}) {
    this.#temporaryRoot = options.temporaryRoot ?? tmpdir();
    this.#inlineDiffBytes = options.inlineDiffBytes ?? DEFAULT_INLINE_DIFF_BYTES;
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
      await transport.sendText("No tracked changes.");
      return Object.freeze({ kind: "empty" });
    }
    if (Buffer.byteLength(content, "utf8") <= this.#inlineDiffBytes) {
      const chunks = splitText(content, DIFF_CHUNK_CHARACTERS);
      for (const [index, chunk] of chunks.entries()) {
        await transport.sendText(
          `Diff (${String(index + 1)}/${String(chunks.length)}):\n${chunk}`,
        );
      }
      return Object.freeze({ kind: "messages", count: chunks.length });
    }

    const directory = await mkdtemp(join(this.#temporaryRoot, TEMPORARY_PREFIX));
    const path = join(directory, DIFF_FILE_NAME);
    try {
      await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
      await transport.sendDocument(path, {
        filename: DIFF_FILE_NAME,
        caption: "Git diff",
      });
      return Object.freeze({ kind: "document" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** Delivers command output safely, using a document when it is too large. */
  public async sendTestOutput(
    transport: MessageTransport,
    content: string,
  ): Promise<DiffDelivery> {
    return this.#sendOutput(
      transport,
      content,
      "Test output",
      TEST_OUTPUT_FILE_NAME,
    );
  }

  async #sendOutput(
    transport: MessageTransport,
    content: string,
    label: string,
    filename: string,
  ): Promise<DiffDelivery> {
    if (content.length === 0) return Object.freeze({ kind: "empty" });
    if (Buffer.byteLength(content, "utf8") <= this.#inlineDiffBytes) {
      const chunks = splitText(content, DIFF_CHUNK_CHARACTERS);
      for (const [index, chunk] of chunks.entries()) {
        await transport.sendText(
          `${label} (${String(index + 1)}/${String(chunks.length)}):\n${chunk}`,
        );
      }
      return Object.freeze({ kind: "messages", count: chunks.length });
    }

    const directory = await mkdtemp(join(this.#temporaryRoot, TEMPORARY_PREFIX));
    const path = join(directory, filename);
    try {
      await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
      await transport.sendDocument(path, { filename, caption: label });
      return Object.freeze({ kind: "document" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
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

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

export const MESSAGE_SENDER_LIMITS = Object.freeze({
  telegramMessageCharacters: TELEGRAM_MESSAGE_LIMIT,
  diffChunkCharacters: DIFF_CHUNK_CHARACTERS,
  defaultInlineDiffBytes: DEFAULT_INLINE_DIFF_BYTES,
});
