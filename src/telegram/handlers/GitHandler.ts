import type { Context } from "grammy";

import type { GitStatusReader } from "../../agent/AgentManager.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import { formatGitDashboard } from "../DashboardFormatter.js";
import { DEFAULT_OPERATION_POLICY, type OperationPolicy } from "../../policy/OperationPolicy.js";

export class GitHandler {
  readonly #projects: ProjectHandler;
  readonly #git: GitStatusReader;
  readonly #policy: OperationPolicy;

  public constructor(projects: ProjectHandler, git: GitStatusReader, policy = DEFAULT_OPERATION_POLICY) {
    this.#projects = projects;
    this.#git = git;
    this.#policy = policy;
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
    if (this.#policy.evaluate(project, "git").kind === "forbidden") {
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
