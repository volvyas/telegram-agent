import type { Context } from "grammy";

import type { ProjectConfig } from "../../config/ProjectConfig.js";
import type { ProjectManager } from "../../projects/ProjectManager.js";
import { ProjectKeyboard } from "../keyboards/ProjectKeyboard.js";

const UNKNOWN_PROJECT_MESSAGE = "Unknown project.";

export class ProjectHandler {
  readonly #projectManager: ProjectManager;
  readonly #keyboard: ProjectKeyboard;
  readonly #activeProjects = new Map<number, string>();

  public constructor(
    projectManager: ProjectManager,
    keyboard = new ProjectKeyboard(),
  ) {
    this.#projectManager = projectManager;
    this.#keyboard = keyboard;
  }

  public async handleStart(context: Context): Promise<void> {
    const activeProject = this.activeProjectFor(context);
    if (activeProject === undefined) {
      await context.reply(
        "Welcome. Select a project to continue.",
        this.projectListOptions(),
      );
      return;
    }

    await context.reply(formatDashboard(activeProject));
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

  private async selectProject(context: Context, projectId: string): Promise<void> {
    const userId = context.from?.id;
    const project = this.#projectManager.get(projectId);
    if (userId === undefined || project === undefined) {
      await context.reply(UNKNOWN_PROJECT_MESSAGE);
      return;
    }

    this.#activeProjects.set(userId, project.id);
    await context.reply(formatDashboard(project));
  }

  private activeProjectFor(context: Context): ProjectConfig | undefined {
    const userId = context.from?.id;
    return userId === undefined ? undefined : this.getActiveProject(userId);
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
    `Available operations: ${operations}`,
  ].join("\n");
}
