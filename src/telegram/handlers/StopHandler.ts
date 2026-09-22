import type { Context } from "grammy";

import type { ProjectOperationStopper } from "../../agent/AgentManager.js";
import type { ProjectHandler } from "./ProjectHandler.js";

/** Stops an active coding-agent or configured-command operation for one project. */
export class StopHandler {
  readonly #projects: ProjectHandler;
  readonly #operations: ProjectOperationStopper;

  public constructor(projects: ProjectHandler, operations: ProjectOperationStopper) {
    this.#projects = projects;
    this.#operations = operations;
  }

  public async handleStopCommand(context: Context): Promise<void> {
    const userId = context.from?.id;
    const project = userId === undefined
      ? undefined
      : await this.#projects.restoreActiveProject(userId);
    if (project === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }
    if (!project.allowedOperations.has("stop")) {
      await context.reply("Stop is not allowed for this project.");
      return;
    }

    try {
      const stopped = await this.#operations.stop(project.id);
      await context.reply(stopped ? "Stop requested." : "No active operation for this project.");
    } catch {
      await context.reply("Unable to stop the active operation.");
    }
  }
}
