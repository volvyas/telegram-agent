import type { Bot } from "grammy";

import type { ProjectHandler } from "./handlers/ProjectHandler.js";
import type { TaskHandler } from "./handlers/TaskHandler.js";
import type { AnswerHandler } from "./handlers/AnswerHandler.js";

export class CommandRouter {
  readonly #projectHandler: ProjectHandler;
  readonly #taskHandler: TaskHandler | undefined;
  readonly #answerHandler: AnswerHandler | undefined;

  public constructor(projectHandler: ProjectHandler, taskHandler?: TaskHandler, answerHandler?: AnswerHandler) {
    this.#projectHandler = projectHandler;
    this.#taskHandler = taskHandler;
    this.#answerHandler = answerHandler;
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
    }
    if (this.#answerHandler !== undefined) {
      const answerHandler = this.#answerHandler;
      bot.command("answer", (context) => answerHandler.handleAnswerCommand(context));
    }
    if (this.#taskHandler !== undefined || this.#answerHandler !== undefined) {
      bot.on("message:text", async (context) => {
        const handledAsTask = await this.#taskHandler?.handleText(context) ?? false;
        if (!handledAsTask) await this.#answerHandler?.handleText(context);
      });
    }
    if (this.#answerHandler !== undefined) {
      const answerHandler = this.#answerHandler;
      bot.callbackQuery(/^answer:/u, (context) => answerHandler.handleCallback(context));
    }
    bot.callbackQuery(/^project:/u, (context) =>
      this.#projectHandler.handleProjectCallback(context),
    );
  }
}
