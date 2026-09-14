import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import type { ProjectManager } from "../../src/projects/ProjectManager.js";
import { AuthGuard } from "../../src/telegram/AuthGuard.js";
import { CommandRouter } from "../../src/telegram/CommandRouter.js";
import { ProjectHandler } from "../../src/telegram/handlers/ProjectHandler.js";
import { TelegramBot } from "../../src/telegram/TelegramBot.js";

const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "Test Bot",
  username: "test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

describe("TelegramBot", () => {
  it("registers the whitelist guard before handlers", async () => {
    const projectHandler = new ProjectHandler(projectManager());
    const startHandler = vi.spyOn(projectHandler, "handleStart");
    const apiCalls: string[] = [];
    const bot = createBot(projectHandler, apiCalls);

    await bot.handleUpdate(commandUpdate(99, "/start"));

    expect(startHandler).not.toHaveBeenCalled();
    expect(apiCalls).toEqual(["sendMessage"]);
  });

  it("does not expose the token through its error logger", async () => {
    const token = "123456:super-secret-token";
    const projectHandler = new ProjectHandler(projectManager());
    vi.spyOn(projectHandler, "handleStart").mockRejectedValue(new Error(token));
    const logger = { error: vi.fn() };
    const bot = new TelegramBot({
      token,
      authGuard: new AuthGuard(new Set([42])),
      commandRouter: new CommandRouter(projectHandler),
      botConfig: { botInfo: BOT_INFO, client: { fetch: fakeFetch([]) } },
      logger,
    });

    await bot.handleUpdate(commandUpdate(42, "/start"));

    expect(logger.error).toHaveBeenCalledWith("Telegram update handling failed.");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(token);
  });
});

function createBot(projectHandler: ProjectHandler, apiCalls: string[]): TelegramBot {
  return new TelegramBot({
    token: "123456:test-token",
    authGuard: new AuthGuard(new Set([42])),
    commandRouter: new CommandRouter(projectHandler),
    botConfig: { botInfo: BOT_INFO, client: { fetch: fakeFetch(apiCalls) } },
  });
}

function fakeFetch(apiCalls: string[]): typeof fetch {
  return vi.fn((input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = url.slice(url.lastIndexOf("/") + 1);
    apiCalls.push(method);
    const result = method === "sendMessage" ? telegramMessage("Unauthorized.") : true;
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, result }), {
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

function commandUpdate(userId: number, text: string): Update {
  return {
    update_id: 1,
    message: {
      ...telegramMessage(text),
      from: { id: userId, is_bot: false, first_name: "User" },
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    },
  };
}

function telegramMessage(text: string) {
  return {
    message_id: 1,
    date: 1,
    chat: { id: 10, type: "private" as const, first_name: "User" },
    text,
  };
}

function projectManager(): ProjectManager {
  const configuredProject: ProjectConfig = {
    id: "api",
    name: "API",
    path: "/private/api",
    allowedOperations: new Set(["task"]),
  };
  return {
    list: () => [configuredProject],
    get: (projectId: string) => projectId === "api" ? configuredProject : undefined,
  } as unknown as ProjectManager;
}
