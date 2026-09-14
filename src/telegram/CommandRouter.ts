import type { Bot } from "grammy";

import type { ProjectHandler } from "./handlers/ProjectHandler.js";

export class CommandRouter {
  readonly #projectHandler: ProjectHandler;

  public constructor(projectHandler: ProjectHandler) {
    this.#projectHandler = projectHandler;
  }

  public register(bot: Bot): void {
    bot.command("start", (context) => this.#projectHandler.handleStart(context));
    bot.command("projects", (context) => this.#projectHandler.handleProjects(context));
    bot.command("project", (context) =>
      this.#projectHandler.handleProjectCommand(context),
    );
    bot.on("callback_query:data", (context) =>
      this.#projectHandler.handleProjectCallback(context),
    );
  }
}
