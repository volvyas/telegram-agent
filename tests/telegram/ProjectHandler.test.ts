import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import type { ProjectManager } from "../../src/projects/ProjectManager.js";
import { ProjectHandler } from "../../src/telegram/handlers/ProjectHandler.js";
import { ProjectKeyboard } from "../../src/telegram/keyboards/ProjectKeyboard.js";
import { DashboardKeyboard } from "../../src/telegram/keyboards/DashboardKeyboard.js";

const projects = [
  project("api", "API service", "/private/repos/api"),
  project("web", "Web app", "/private/repos/web", "/private/codex-profiles/web-codex"),
];

describe("ProjectHandler", () => {
  it("lists configured projects with an inline keyboard that contains no paths", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const handler = new ProjectHandler(projectManager(projects));

    await handler.handleProjects(context({ userId: 42, reply }));

    const [message, options] = (reply.mock.calls as unknown[][])[0] ?? [];
    expect(message).toContain("API service (api)");
    expect(message).toContain("Web app (web)");
    expect(JSON.stringify(options)).not.toContain("/private/repos");
  });

  it("selects a project by command and keeps selection per user", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const handler = new ProjectHandler(projectManager(projects));

    await handler.handleProjectCommand(
      context({ userId: 42, text: "/project api", reply }),
    );

    expect(handler.getActiveProject(42)?.id).toBe("api");
    expect(handler.getActiveProject(7)).toBeUndefined();
    expect(reply).toHaveBeenLastCalledWith(expect.stringContaining("Active project: API service"));
    expect(JSON.stringify(reply.mock.calls)).not.toContain("/private/codex-profiles");
  });

  it("selects a project through a validated opaque callback", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const answerCallbackQuery = vi.fn(() => Promise.resolve());
    const keyboard = new ProjectKeyboard();
    const handler = new ProjectHandler(projectManager(projects), keyboard);
    const callbackData = keyboard.callbackData("web");

    await handler.handleProjectCallback(
      context({ userId: 42, callbackData, reply, answerCallbackQuery }),
    );

    expect(callbackData).not.toContain("web");
    expect(callbackData).not.toContain(projects[1]?.path);
    expect(handler.getActiveProject(42)?.id).toBe("web");
    expect(answerCallbackQuery).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Active project: Web app"));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Codex: web-codex"));
    expect(JSON.stringify(reply.mock.calls)).not.toContain("/private/codex-profiles/web-codex");
  });

  it("handles unknown command and callback project IDs without throwing", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const answerCallbackQuery = vi.fn(() => Promise.resolve());
    const handler = new ProjectHandler(projectManager(projects));

    await handler.handleProjectCommand(
      context({ userId: 42, text: "/project missing", reply }),
    );
    await handler.handleProjectCallback(
      context({
        userId: 42,
        callbackData: "project:not-a-valid-token",
        reply,
        answerCallbackQuery,
      }),
    );

    expect(reply).toHaveBeenCalledWith("Unknown project.");
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: "Unknown project.",
      show_alert: true,
    });
    expect(handler.getActiveProject(42)).toBeUndefined();
  });

  it("shows the selected project dashboard on /start", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const handler = new ProjectHandler(projectManager(projects));
    await handler.handleProjectCommand(
      context({ userId: 42, text: "/project api", reply }),
    );

    reply.mockClear();
    await handler.handleStart(context({ userId: 42, reply }));

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Available operations: task, test"));
  });

  it("restores the active project and dashboard after a restart", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const storage = {
      load: vi.fn(async () => ({
        activeProjects: { "42": { projectId: "web", updatedAt: "2026-09-25T00:00:00.000Z" } },
      })),
    } as never;
    const dashboard = new DashboardKeyboard();
    const handler = new ProjectHandler(projectManager(projects), undefined, storage, dashboard);

    await handler.handleStart(context({ userId: 42, reply }));

    const options = (reply.mock.calls[0] as unknown[] | undefined)?.[1] as { reply_markup?: unknown } | undefined;
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Active project: Web app"), expect.objectContaining({ reply_markup: expect.anything() }));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Codex: web-codex"), expect.anything());
    expect(options?.reply_markup).toBeDefined();
    expect(handler.getActiveProject(42)?.id).toBe("web");
    expect(JSON.stringify(reply.mock.calls)).not.toContain("/private/codex-profiles/web-codex");
  });

  it("sanitizes the final Codex profile component", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const unsafe = project("unsafe", "Unsafe profile", "/private/repos/unsafe", "/private/codex/\nprofile\tname/");
    const handler = new ProjectHandler(projectManager([unsafe]));

    await handler.handleProjectCommand(
      context({ userId: 42, text: "/project unsafe", reply }),
    );

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Codex: profilename"));
    expect(JSON.stringify(reply.mock.calls)).not.toContain("/private/codex");
    expect(JSON.stringify(reply.mock.calls)).not.toContain("profile\\tname");
  });
});

interface ContextOptions {
  readonly userId: number;
  readonly text?: string;
  readonly callbackData?: string;
  readonly reply: ReturnType<typeof vi.fn>;
  readonly answerCallbackQuery?: ReturnType<typeof vi.fn>;
}

function context(options: ContextOptions): Context {
  return {
    from: { id: options.userId },
    message: options.text === undefined ? undefined : { text: options.text },
    callbackQuery:
      options.callbackData === undefined ? undefined : { data: options.callbackData },
    reply: options.reply,
    answerCallbackQuery: options.answerCallbackQuery,
  } as unknown as Context;
}

function project(id: string, name: string, path: string, codexHome?: string): ProjectConfig {
  return Object.freeze({
    id,
    name,
    path,
    ...(codexHome === undefined ? {} : { codexHome }),
    allowedOperations: new Set(["task", "test"] as const),
  });
}

function projectManager(configuredProjects: readonly ProjectConfig[]): ProjectManager {
  const byId = new Map(configuredProjects.map((configuredProject) => [configuredProject.id, configuredProject]));
  return {
    list: () => configuredProjects,
    get: (projectId: string) => byId.get(projectId),
  } as unknown as ProjectManager;
}
