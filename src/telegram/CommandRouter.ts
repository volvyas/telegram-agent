import type { Bot } from "grammy";

import type { ProjectHandler } from "./handlers/ProjectHandler.js";
import type { TaskHandler } from "./handlers/TaskHandler.js";

export class CommandRouter {
  readonly #projectHandler: ProjectHandler;
  readonly #taskHandler: TaskHandler | undefined;

  public constructor(projectHandler: ProjectHandler, taskHandler?: TaskHandler) {
    this.#projectHandler = projectHandler;
    this.#taskHandler = taskHandler;
  }

  public register(bot: Bot): void {
    bot.command("start", (context) => this.#projectHandler.handleStart(context));
    bot.command("projects", (context) => this.#projectHandler.handleProjects(context));
    bot.command("project", (context) =>
      this.#projectHandler.handleProjectCommand(context),
    );
    if (this.#taskHandler !== undefined) {
      const taskHandler = this.#taskHandler;
      bot.command("task", (context) => taskHandler.handleTaskCommand(context));
      bot.on("message:text", (context) => taskHandler.handleText(context));
    }
    bot.on("callback_query:data", (context) =>
      this.#projectHandler.handleProjectCallback(context),
    );
  }
}
