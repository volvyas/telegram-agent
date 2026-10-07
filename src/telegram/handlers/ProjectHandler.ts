import type { Context } from "grammy";

import type { ProjectConfig } from "../../config/ProjectConfig.js";
import type { ProjectManager } from "../../projects/ProjectManager.js";
import type { Storage } from "../../storage/Storage.js";
import { ProjectKeyboard } from "../keyboards/ProjectKeyboard.js";
import type { DashboardKeyboard } from "../keyboards/DashboardKeyboard.js";
import { telegramActorId } from "../../domain/Actor.js";

const UNKNOWN_PROJECT_MESSAGE = "Unknown project.";

export class ProjectHandler {
  readonly #projectManager: ProjectManager;
  readonly #keyboard: ProjectKeyboard;
  readonly #activeProjects = new Map<number, string>();
  readonly #storage: Storage | undefined;
  readonly #dashboard: DashboardKeyboard | undefined;

  public constructor(
    projectManager: ProjectManager,
    keyboard = new ProjectKeyboard(),
    storage?: Storage,
    dashboard?: DashboardKeyboard,
  ) {
    this.#projectManager = projectManager;
    this.#keyboard = keyboard;
    this.#storage = storage;
    this.#dashboard = dashboard;
  }

  public async handleStart(context: Context): Promise<void> {
    const activeProject = await this.activeProjectFor(context);
    if (activeProject === undefined) {
      await context.reply(
        "Welcome. Select a project to continue.",
        this.projectListOptions(),
      );
      return;
    }

    await this.replyDashboard(context, activeProject);
  }

  public async handleProjects(context: Context): Promise<void> {
    await context.reply(formatProjectList(this.#projectManager.list()), this.projectListOptions());
  }

  public async handleProjectCommand(context: Context): Promise<void> {
    const projectId = readProjectCommandArgument(context.message?.text);
    if (projectId === undefined) {
      await context.reply("Usage: /project <id>");
      return;
    }

    await this.selectProject(context, projectId);
  }

  public async handleProjectCallback(context: Context): Promise<void> {
    const callbackData = context.callbackQuery?.data;
    const projectId =
      callbackData === undefined ? undefined : this.#keyboard.resolve(callbackData);

    if (projectId === undefined || this.#projectManager.get(projectId) === undefined) {
      await context.answerCallbackQuery({ text: UNKNOWN_PROJECT_MESSAGE, show_alert: true });
      return;
    }

    await context.answerCallbackQuery();
    await this.selectProject(context, projectId);
  }

  public getActiveProject(userId: number): ProjectConfig | undefined {
    const projectId = this.#activeProjects.get(userId);
    return projectId === undefined ? undefined : this.#projectManager.get(projectId);
  }

  public async restoreActiveProject(userId: number): Promise<ProjectConfig | undefined> {
    const active = this.getActiveProject(userId);
    if (active !== undefined || this.#storage === undefined) return active;
    const state = await this.#storage.load();
    const record = state.activeProjects[telegramActorId(userId)] ?? state.activeProjects[String(userId)];
    const project = record === undefined ? undefined : this.#projectManager.get(record.projectId);
    if (project !== undefined) this.#activeProjects.set(userId, project.id);
    return project;
  }

  private async selectProject(context: Context, projectId: string): Promise<void> {
    const userId = context.from?.id;
    const project = this.#projectManager.get(projectId);
    if (userId === undefined || project === undefined) {
      await context.reply(UNKNOWN_PROJECT_MESSAGE);
      return;
    }

    this.#activeProjects.set(userId, project.id);
    if (this.#storage !== undefined) {
      const updatedAt = new Date().toISOString();
      await this.#storage.update((state) => ({
        ...state,
        activeProjects: {
          ...state.activeProjects,
          [telegramActorId(userId)]: { actorId: telegramActorId(userId), projectId: project.id, updatedAt },
          [String(userId)]: { actorId: telegramActorId(userId), projectId: project.id, updatedAt },
        },
      }));
    }
    await this.replyDashboard(context, project);
  }

  private async activeProjectFor(context: Context): Promise<ProjectConfig | undefined> {
    const userId = context.from?.id;
    return userId === undefined ? undefined : this.restoreActiveProject(userId);
  }

  private async replyDashboard(context: Context, project: ProjectConfig): Promise<void> {
    if (this.#dashboard === undefined) {
      await context.reply(formatDashboard(project));
      return;
    }
    await context.reply(formatDashboard(project), { reply_markup: this.#dashboard.build(project) });
  }

  private projectListOptions(): { readonly reply_markup: ReturnType<ProjectKeyboard["build"]> } {
    return { reply_markup: this.#keyboard.build(this.#projectManager.list()) };
  }
}

function readProjectCommandArgument(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const [, projectId, ...extra] = text.trim().split(/\s+/u);
  return projectId === undefined || projectId.length === 0 || extra.length > 0
    ? undefined
    : projectId;
}

function formatProjectList(projects: readonly ProjectConfig[]): string {
  const rows = projects.map((project) => `• ${project.name} (${project.id})`);
  return ["Projects:", ...rows].join("\n");
}

function formatDashboard(project: ProjectConfig): string {
  const operations = [...project.allowedOperations].join(", ");
  return [
    `Active project: ${project.name} (${project.id})`,
    ...(project.codexHome === undefined ? [] : [`Codex: ${codexIdentifier(project.codexHome)}`]),
    `Available operations: ${operations}`,
  ].join("\n");
}

function codexIdentifier(codexHome: string): string {
  const withoutTrailingSeparators = codexHome.replace(/[\\/]+$/u, "");
  const separator = Math.max(
    withoutTrailingSeparators.lastIndexOf("/"),
    withoutTrailingSeparators.lastIndexOf("\\"),
  );
  const component = [...withoutTrailingSeparators.slice(separator + 1)]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim();
  const display = component.replace(/^\.(?:codex|claude)-/u, "");
  return display.length === 0 ? "configured" : display.slice(0, 128);
}
