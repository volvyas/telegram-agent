import type { Bot } from "grammy";

import type { ProjectHandler } from "./handlers/ProjectHandler.js";
import type { TaskHandler } from "./handlers/TaskHandler.js";
import type { AnswerHandler } from "./handlers/AnswerHandler.js";
import type { GitHandler } from "./handlers/GitHandler.js";
import type { StatusHandler } from "./handlers/StatusHandler.js";

export class CommandRouter {
  readonly #projectHandler: ProjectHandler;
  readonly #taskHandler: TaskHandler | undefined;
  readonly #answerHandler: AnswerHandler | undefined;
  readonly #gitHandler: GitHandler | undefined;
  readonly #statusHandler: StatusHandler | undefined;

  public constructor(
    projectHandler: ProjectHandler,
    taskHandler?: TaskHandler,
    answerHandler?: AnswerHandler,
    gitHandler?: GitHandler,
    statusHandler?: StatusHandler,
  ) {
    this.#projectHandler = projectHandler;
    this.#taskHandler = taskHandler;
    this.#answerHandler = answerHandler;
    this.#gitHandler = gitHandler;
    this.#statusHandler = statusHandler;
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
    if (this.#gitHandler !== undefined) {
      const gitHandler = this.#gitHandler;
      bot.command("git", (context) => gitHandler.handleGitCommand(context));
    }
    if (this.#statusHandler !== undefined) {
      const statusHandler = this.#statusHandler;
      bot.command("status", (context) => statusHandler.handleStatusCommand(context));
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
