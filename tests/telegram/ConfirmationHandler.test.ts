import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

import { ConfirmationService } from "../../src/confirmations/ConfirmationService.js";
import { JsonStorage } from "../../src/storage/JsonStorage.js";
import { ProjectHandler } from "../../src/telegram/handlers/ProjectHandler.js";
import { ConfirmationHandler } from "../../src/telegram/handlers/ConfirmationHandler.js";
import { ConfirmationKeyboard } from "../../src/telegram/keyboards/ConfirmationKeyboard.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ConfirmationHandler", () => {
  it("shows an operation summary and consumes an allow callback once", async () => {
    const storage = new JsonStorage(await dataDirectory());
    const projects = new ProjectHandler(projectManager(), undefined, storage);
    await storage.update((state) => ({
      ...state,
      activeProjects: { "42": { projectId: "api", updatedAt: "2026-09-23T10:00:00.000Z" } },
    }));
    const service = new ConfirmationService(storage, { idFactory: () => "opaque-confirmation-037" });
    const handler = new ConfirmationHandler(service, projects);
    const request = context(42);

    await handler.request(request, "api", "commit", "Commit 2 files (+4/-1) on main");
    const confirmation = (await storage.load()).confirmations[0];
    expect(request.reply).toHaveBeenCalledWith(
      expect.stringContaining("Commit 2 files (+4/-1) on main"),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(confirmation).toBeDefined();

    const callback = new ConfirmationKeyboard().callbackData(confirmation?.id ?? "", "allow");
    const callbackContext = context(42, callback);
    await handler.handleCallback(callbackContext);
    const replayContext = context(42, callback);
    await handler.handleCallback(replayContext);

    expect(callbackContext.answerCallbackQuery).toHaveBeenCalledWith();
    expect(callbackContext.reply).toHaveBeenCalledWith("Allowed once.");
    expect((await storage.load()).confirmations).toHaveLength(0);
    expect((replayContext.answerCallbackQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ show_alert: true });
    await storage.close();
  });

  it("rejects forged callbacks and wrong users without executing anything", async () => {
    const storage = new JsonStorage(await dataDirectory());
    const projects = new ProjectHandler(projectManager(), undefined, storage);
    await storage.update((state) => ({
      ...state,
      activeProjects: { "42": { projectId: "api", updatedAt: "2026-09-23T10:00:00.000Z" } },
    }));
    const service = new ConfirmationService(storage, { idFactory: () => "opaque-confirmation-038" });
    const handler = new ConfirmationHandler(service, projects);
    const pending = await service.request(42, "api", "commit");
    const keyboard = new ConfirmationKeyboard();

    await handler.handleCallback(context(99, keyboard.callbackData(pending.id, "allow")));
    expect((await storage.load()).confirmations).toHaveLength(1);
    await handler.handleCallback(context(42, "confirm:allow:forged-confirmation-id"));
    expect((await storage.load()).confirmations).toHaveLength(1);
    await storage.close();
  });
});

function context(userId: number, callbackData?: string) {
  return {
    from: { id: userId },
    callbackQuery: callbackData === undefined ? undefined : { data: callbackData },
    reply: vi.fn(() => Promise.resolve({ message_id: 1 })),
    answerCallbackQuery: vi.fn(() => Promise.resolve(true)),
  } as unknown as Context & {
    readonly reply: ReturnType<typeof vi.fn>;
    readonly answerCallbackQuery: ReturnType<typeof vi.fn>;
  };
}

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-telegram-confirmation-test-"));
  directories.push(root);
  return join(root, "data");
}

function projectManager() {
  const project = {
    id: "api", name: "API", path: "/private/api", allowedOperations: new Set(["commit"]),
  };
  return {
    list: () => [project],
    get: (id: string) => id === "api" ? project : undefined,
    require: () => project,
  } as never;
}
