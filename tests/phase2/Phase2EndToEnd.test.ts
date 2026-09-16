import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Update, UserFromGetMe } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentManager, type AgentProjectRegistry } from "../../src/agent/AgentManager.js";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";
import type { AgentRun } from "../../src/agent/AgentRun.js";
import type { AgentMessageOptions, AgentResumeOptions, AgentStartOptions, CodingAgent } from "../../src/agent/CodingAgent.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import { SessionManager } from "../../src/sessions/SessionManager.js";
import { JsonStorage } from "../../src/storage/JsonStorage.js";
import { AuthGuard } from "../../src/telegram/AuthGuard.js";
import { CommandRouter } from "../../src/telegram/CommandRouter.js";
import { ProgressReporter } from "../../src/telegram/ProgressReporter.js";
import { TelegramBot } from "../../src/telegram/TelegramBot.js";
import { AnswerHandler } from "../../src/telegram/handlers/AnswerHandler.js";
import { ProjectHandler } from "../../src/telegram/handlers/ProjectHandler.js";
import { TaskHandler } from "../../src/telegram/handlers/TaskHandler.js";

const temporaryDirectories: string[] = [];
const occurredAt = "2026-09-16T10:00:00.000Z";
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Phase 2 gateway flow", () => {
  it("routes two projects through Telegram and answers a persisted question after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-remote-phase2-test-"));
    temporaryDirectories.push(root);
    const projects = registry();
    const firstStorage = new JsonStorage(join(root, "data"));
    const firstAgent = new ScenarioAgent();
    const firstMessages: string[] = [];
    const firstEdits: string[] = [];
    const first = gateway(firstAgent, projects, firstStorage, firstMessages, firstEdits);

    await first.bot.handleUpdate(commandUpdate(1, "/project api"));
    await first.bot.handleUpdate(commandUpdate(2, "/task Ask for a deployment choice"));
    await first.bot.handleUpdate(commandUpdate(3, "/project crypto"));
    await first.bot.handleUpdate(commandUpdate(4, "/task Update the changelog"));
    await first.bot.handleUpdate(commandUpdate(5, "/project api"));

    expect(first.manager.getSession("api")).toMatchObject({ state: "WAITING_FOR_USER", threadId: "THREAD-api" });
    expect(first.manager.getSession("crypto")).toMatchObject({ state: "COMPLETED", threadId: "THREAD-crypto" });
    expect(first.projects.getActiveProject(42)?.id).toBe("api");
    expect(firstEdits).toEqual(expect.arrayContaining([
      expect.stringContaining("Inspecting api"),
      expect.stringContaining("Inspecting crypto"),
    ]));
    await firstStorage.close();

    const secondStorage = new JsonStorage(join(root, "data"));
    const secondAgent = new ScenarioAgent();
    const secondMessages: string[] = [];
    const second = gateway(secondAgent, projects, secondStorage, secondMessages, []);

    await second.bot.handleUpdate(commandUpdate(6, "/start"));
    await second.bot.handleUpdate(textUpdate(7, "deploy blue"));
    await second.bot.handleUpdate(commandUpdate(8, "/project crypto"));
    await second.bot.handleUpdate(commandUpdate(9, "/task Follow up"));

    expect(secondMessages).toContain("Active project: API (api)\nAvailable operations: task");
    expect(secondAgent.messages).toEqual([{
      projectId: "api",
      workingDirectory: "/projects/api",
      threadId: "THREAD-api",
      message: "deploy blue",
    }]);
    expect(secondAgent.resumes).toEqual([{
      projectId: "crypto",
      workingDirectory: "/projects/crypto",
      threadId: "THREAD-crypto",
      prompt: "Follow up",
    }]);
    expect(second.manager.getSession("api")).toMatchObject({ state: "COMPLETED", threadId: "THREAD-api" });
    expect(second.manager.getSession("crypto")).toMatchObject({ state: "COMPLETED", threadId: "THREAD-crypto" });
    await secondStorage.close();
  });
});

class ScenarioAgent implements CodingAgent {
  public readonly messages: AgentMessageOptions[] = [];
  public readonly resumes: AgentResumeOptions[] = [];

  public start(options: AgentStartOptions): Promise<AgentRun> {
    return Promise.resolve(this.#run(options.projectId, "start"));
  }

  public resume(options: AgentResumeOptions): Promise<AgentRun> {
    this.resumes.push(options);
    return Promise.resolve(this.#run(options.projectId, "resume"));
  }

  public send(options: AgentMessageOptions): Promise<AgentRun> {
    this.messages.push(options);
    return Promise.resolve(this.#run(options.projectId, "answer"));
  }

  public stop(): Promise<boolean> { return Promise.resolve(false); }

  #run(projectId: string, kind: "start" | "resume" | "answer"): AgentRun {
    const runId = `${projectId}-${kind}`;
    const threadId = `THREAD-${projectId}`;
    const terminal: AgentEvent = projectId === "api" && kind === "start"
      ? event("question", projectId, runId, { questionId: "QUESTION-api", question: "Which deployment?", choices: ["blue", "green"] })
      : event("completed", projectId, runId, { summary: "Done" });
    return { projectId, runId, events: events([
      event("thread_started", projectId, runId, { threadId }),
      event("progress", projectId, runId, { message: `Inspecting ${projectId}` }),
      terminal,
    ]) };
  }
}

function gateway(
  agent: CodingAgent,
  projects: AgentProjectRegistry,
  storage: JsonStorage,
  messages: string[],
  edits: string[],
): { readonly bot: TelegramBot; readonly manager: AgentManager; readonly projects: ProjectHandler } {
  const progress = new ProgressReporter();
  const manager = new AgentManager(agent, projects, {
    clock: () => new Date(occurredAt),
    sessionStore: new SessionManager(storage, projects),
    onEvent: (event) => progress.onEvent(event),
  });
  const projectHandler = new ProjectHandler(projects as never, undefined, storage);
  const answerHandler = new AnswerHandler(manager, projectHandler, progress);
  const taskHandler = new TaskHandler(manager, projectHandler, answerHandler, progress);
  const bot = new TelegramBot({
    token: "123456:test-token",
    authGuard: new AuthGuard(new Set([42])),
    commandRouter: new CommandRouter(projectHandler, taskHandler, answerHandler),
    botConfig: { botInfo: BOT_INFO, client: { fetch: recordingFetch(messages, edits) } },
  });
  return { bot, manager, projects: projectHandler };
}

function registry(): AgentProjectRegistry {
  const configured = [project("api"), project("crypto")];
  return {
    require(id) {
      const found = configured.find((item) => item.id === id);
      if (found === undefined) throw new Error("Project not found");
      return found;
    },
    get(id: string) { return configured.find((item) => item.id === id); },
    list() { return configured; },
  } as AgentProjectRegistry;
}

function project(id: string): ProjectConfig {
  return { id, name: id === "api" ? "API" : "Crypto", path: `/projects/${id}`, allowedOperations: new Set(["task"]) };
}

function commandUpdate(updateId: number, value: string): Update {
  return {
    ...textUpdate(updateId, value),
    message: {
      ...telegramMessage(value),
      from: { id: 42, is_bot: false, first_name: "User" },
      entities: [{ type: "bot_command", offset: 0, length: commandLength(value) }],
    },
  };
}

function textUpdate(updateId: number, value: string): Update {
  return {
    update_id: updateId,
    message: {
      ...telegramMessage(value),
      from: { id: 42, is_bot: false, first_name: "User" },
    },
  };
}

function commandLength(value: string): number {
  const whitespace = value.search(/\s/u);
  return whitespace < 0 ? value.length : whitespace;
}

function telegramMessage(value: string) {
  return {
    message_id: 1,
    date: 1,
    chat: { id: 10, type: "private" as const, first_name: "User" },
    text: value,
  };
}

function recordingFetch(messages: string[], edits: string[]): typeof fetch {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = url.slice(url.lastIndexOf("/") + 1);
    if (typeof init?.body === "string") {
      const payload = JSON.parse(init.body) as { readonly text?: unknown };
      if (typeof payload.text === "string") {
        if (method === "sendMessage") messages.push(payload.text);
        if (method === "editMessageText") edits.push(payload.text);
      }
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result: telegramMessage("sent") }), {
      headers: { "content-type": "application/json" },
    }));
  });
}

function event(type: AgentEvent["type"], projectId: string, runId: string, fields: Record<string, unknown>): AgentEvent {
  return { type, projectId, runId, occurredAt, ...fields } as AgentEvent;
}

async function* events(items: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  yield* items;
}
