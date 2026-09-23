import type { Context } from "grammy";

import type { ProjectOperationStopper } from "../../agent/AgentManager.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import { DEFAULT_OPERATION_POLICY, type OperationPolicy } from "../../policy/OperationPolicy.js";

/** Stops an active coding-agent or configured-command operation for one project. */
export class StopHandler {
  readonly #projects: ProjectHandler;
  readonly #operations: ProjectOperationStopper;
  readonly #policy: OperationPolicy;

  public constructor(projects: ProjectHandler, operations: ProjectOperationStopper, policy = DEFAULT_OPERATION_POLICY) {
    this.#projects = projects;
    this.#operations = operations;
    this.#policy = policy;
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
    if (this.#policy.evaluate(project, "stop").kind === "forbidden") {
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
