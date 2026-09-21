import type { Context } from "grammy";

import type { GitStatusReader } from "../../agent/AgentManager.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import { formatGitDashboard } from "../DashboardFormatter.js";

export class GitHandler {
  readonly #projects: ProjectHandler;
  readonly #git: GitStatusReader;

  public constructor(projects: ProjectHandler, git: GitStatusReader) {
    this.#projects = projects;
    this.#git = git;
  }

  public async handleGitCommand(context: Context): Promise<void> {
    const userId = context.from?.id;
    const project = userId === undefined
      ? undefined
      : await this.#projects.restoreActiveProject(userId);
    if (project === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }
    if (!project.allowedOperations.has("git")) {
      await context.reply("Git status is not allowed for this project.");
      return;
    }

    try {
      const status = await this.#git.getStatus(project.path);
      await context.reply(formatGitDashboard(project, status));
    } catch {
      await context.reply("Unable to read Git status.");
    }
  }
}
