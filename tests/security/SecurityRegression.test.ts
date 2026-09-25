import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { StructuredLogger } from "../../src/logging/StructuredLogger.js";
import { ProcessRunner } from "../../src/process/ProcessRunner.js";
import { JsonStorage } from "../../src/storage/JsonStorage.js";
import { AuthGuard } from "../../src/telegram/AuthGuard.js";
import { MessageSender, type MessageTransport } from "../../src/telegram/MessageSender.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("security regressions", () => {
  it("never evaluates process arguments as shell syntax", async () => {
    const root = await temporaryDirectory();
    const marker = join(root, "shell-injection-marker");
    const hostile = `$(touch ${marker}); touch ${marker}`;
    const result = await new ProcessRunner().run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", hostile],
      cwd: root,
      env: {},
    });

    expect(result.stdout).toBe(hostile);
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps storage inside a real private directory", async () => {
    const root = await temporaryDirectory();
    const data = join(root, "data");
    const storage = new JsonStorage(data);
    await storage.update((state) => state);
    await chmod(data, 0o777);
    await chmod(join(data, "state.json"), 0o666);
    await storage.close();

    const reopened = new JsonStorage(data);
    await reopened.load();
    expect((await lstat(data)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(data, "state.json"))).mode & 0o777).toBe(0o600);
    await reopened.close();
    expect(() => new JsonStorage(data, "../outside.json")).toThrow(/must not leave/u);
  });

  it("rejects a symlink as the storage directory", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "target");
    const link = join(root, "data");
    await mkdir(target);
    await symlink(target, link);

    await expect(new JsonStorage(link).load()).rejects.toMatchObject({
      code: "STORAGE_READ_FAILED",
    });
  });

  it("creates uploaded temporary documents with private permissions and cleans them", async () => {
    const root = await temporaryDirectory();
    let documentPath = "";
    const transport: MessageTransport = {
      sendText: vi.fn(() => Promise.resolve()),
      sendDocument: vi.fn(async (path) => {
        documentPath = path;
        expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
        expect((await lstat(path)).mode & 0o777).toBe(0o600);
      }),
    };

    await new MessageSender({ temporaryRoot: root, inlineDiffBytes: 1 })
      .sendDiff(transport, "private diff");
    await expect(lstat(documentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks unauthorized callback updates before routing", async () => {
    const next = vi.fn(() => Promise.resolve());
    const answerCallbackQuery = vi.fn(() => Promise.resolve());
    const middleware = new AuthGuard(new Set([42])).middleware();

    await middleware({
      from: { id: 99 },
      callbackQuery: { data: "confirm:allow:opaque-confirmation" },
      answerCallbackQuery,
    } as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: "Unauthorized.",
      show_alert: true,
    });
  });

  it("redacts credentials, session identifiers, and path-shaped fields", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({
      secrets: ["bot-secret"],
      sink: (line) => lines.push(line),
    });
    logger.error("failed with bot-secret", {
      credential: "bot-secret",
      threadId: "private-thread",
      checkoutPath: "/private/repository",
    });

    const output = lines.join("\n");
    expect(output).not.toContain("bot-secret");
    expect(output).not.toContain("private-thread");
    expect(output).not.toContain("/private/repository");
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "telegram-agent-security-test-"));
  temporaryDirectories.push(path);
  return path;
}
