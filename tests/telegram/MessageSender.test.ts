import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MESSAGE_SENDER_LIMITS,
  MessageSender,
  type MessageTransport,
} from "../../src/telegram/MessageSender.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("MessageSender", () => {
  it("splits a Unicode diff without interpreting embedded code fences", async () => {
    const content = "diff --git a/ї b/ї\n+Привіт ```diff\n".repeat(140);
    const messages: string[] = [];
    const transport = textTransport(messages);

    const result = await new MessageSender().sendDiff(transport, content);

    expect(result).toEqual({ kind: "messages", count: 2 });
    expect(messages.every(
      (message) => message.length <= MESSAGE_SENDER_LIMITS.telegramMessageCharacters,
    )).toBe(true);
    expect(messages.map(withoutHeader).join("")).toBe(content);
    expect(messages.join("")).toContain("```diff");
    expect(transport.sendDocument).not.toHaveBeenCalled();
  });

  it("sends a large diff as a temporary document and cleans it after success", async () => {
    const root = await temporaryDirectory();
    let documentPath: string | undefined;
    let uploadedContent: string | undefined;
    const transport: MessageTransport = {
      sendText: vi.fn(() => Promise.resolve()),
      sendDocument: vi.fn(async (path, options) => {
        documentPath = path;
        uploadedContent = await readFile(path, "utf8");
        expect(options).toEqual({ filename: "changes.diff", caption: "Git diff" });
      }),
    };
    const content = "large diff\n".repeat(20);

    await expect(
      new MessageSender({ temporaryRoot: root, inlineDiffBytes: 10 })
        .sendDiff(transport, content),
    ).resolves.toEqual({ kind: "document" });

    expect(uploadedContent).toBe(content);
    expect(documentPath).toBeDefined();
    await expect(access(documentPath ?? "missing")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans the temporary document when upload fails", async () => {
    const root = await temporaryDirectory();
    let documentPath: string | undefined;
    const transport: MessageTransport = {
      sendText: vi.fn(() => Promise.resolve()),
      sendDocument: vi.fn((path) => {
        documentPath = path;
        return Promise.reject(new Error("upload failed"));
      }),
    };

    await expect(
      new MessageSender({ temporaryRoot: root, inlineDiffBytes: 1 })
        .sendDiff(transport, "too large"),
    ).rejects.toThrow("upload failed");

    expect(documentPath).toBeDefined();
    await expect(access(documentPath ?? "missing")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sends large test output as a temporary document", async () => {
    const root = await temporaryDirectory();
    let uploadedContent: string | undefined;
    const transport: MessageTransport = {
      sendText: vi.fn(() => Promise.resolve()),
      sendDocument: vi.fn(async (path, options) => {
        uploadedContent = await readFile(path, "utf8");
        expect(options).toEqual({ filename: "test-output.txt", caption: "Test output" });
      }),
    };
    const content = "test output\n".repeat(20);

    await expect(
      new MessageSender({ temporaryRoot: root, inlineDiffBytes: 10 })
        .sendTestOutput(transport, content),
    ).resolves.toEqual({ kind: "document" });

    expect(uploadedContent).toBe(content);
  });

  it("sends long Unicode text within Telegram limits and preserves content", async () => {
    const content = "Ї🙂 line\n".repeat(1_200);
    const messages: string[] = [];
    const result = await new MessageSender().sendLongMessage(textTransport(messages), content);

    expect(result.kind).toBe("messages");
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= MESSAGE_SENDER_LIMITS.telegramMessageCharacters)).toBe(true);
    expect(messages.join("")).toBe(content);
  });

  it("reopens fenced blocks when a long message crosses a chunk boundary", async () => {
    const content = `\`\`\`typescript\n${"const value = 1;\n".repeat(500)}\`\`\``;
    const messages: string[] = [];
    await new MessageSender().sendLongMessage(textTransport(messages), content);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= MESSAGE_SENDER_LIMITS.telegramMessageCharacters)).toBe(true);
    expect(messages.every((message) => (message.match(/```/gu)?.length ?? 0) % 2 === 0)).toBe(true);
  });
});

function textTransport(messages: string[]): MessageTransport & {
  readonly sendDocument: ReturnType<typeof vi.fn>;
} {
  return {
    sendText: vi.fn((message: string) => {
      messages.push(message);
      return Promise.resolve();
    }),
    sendDocument: vi.fn(() => Promise.resolve()),
  };
}

function withoutHeader(message: string): string {
  return message.slice(message.indexOf("\n") + 1);
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-remote-message-test-"));
  temporaryDirectories.push(path);
  return path;
}
