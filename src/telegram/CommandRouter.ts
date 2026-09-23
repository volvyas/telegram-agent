import type { Bot } from "grammy";

import type { ProjectHandler } from "./handlers/ProjectHandler.js";
import type { TaskHandler } from "./handlers/TaskHandler.js";
import type { AnswerHandler } from "./handlers/AnswerHandler.js";
import type { GitHandler } from "./handlers/GitHandler.js";
import type { StatusHandler } from "./handlers/StatusHandler.js";
import type { DiffHandler } from "./handlers/DiffHandler.js";
import type { TestHandler } from "./handlers/TestHandler.js";
import type { StopHandler } from "./handlers/StopHandler.js";
import type { HelpHandler } from "./handlers/HelpHandler.js";
import type { LogHandler } from "./handlers/LogHandler.js";
import type { ContinueHandler } from "./handlers/ContinueHandler.js";
import type { DashboardKeyboard } from "./keyboards/DashboardKeyboard.js";
import type { ConfirmationHandler } from "./handlers/ConfirmationHandler.js";
import type { CommitHandler } from "./handlers/CommitHandler.js";
import { DEFAULT_OPERATION_POLICY } from "../policy/OperationPolicy.js";

export class CommandRouter {
  readonly #projectHandler: ProjectHandler;
  readonly #taskHandler: TaskHandler | undefined;
  readonly #answerHandler: AnswerHandler | undefined;
  readonly #gitHandler: GitHandler | undefined;
  readonly #statusHandler: StatusHandler | undefined;
  readonly #diffHandler: DiffHandler | undefined;
  readonly #testHandler: TestHandler | undefined;
  readonly #stopHandler: StopHandler | undefined;
  readonly #helpHandler: HelpHandler | undefined;
  readonly #logHandler: LogHandler | undefined;
  readonly #continueHandler: ContinueHandler | undefined;
  readonly #dashboard: DashboardKeyboard | undefined;
  readonly #confirmationHandler: ConfirmationHandler | undefined;
  readonly #commitHandler: CommitHandler | undefined;

  public constructor(
    projectHandler: ProjectHandler,
    taskHandler?: TaskHandler,
    answerHandler?: AnswerHandler,
    gitHandler?: GitHandler,
    statusHandler?: StatusHandler,
    diffHandler?: DiffHandler,
    testHandler?: TestHandler,
    stopHandler?: StopHandler,
    helpHandler?: HelpHandler,
    logHandler?: LogHandler,
    continueHandler?: ContinueHandler,
    dashboard?: DashboardKeyboard,
    confirmationHandler?: ConfirmationHandler,
    commitHandler?: CommitHandler,
  ) {
    this.#projectHandler = projectHandler;
    this.#taskHandler = taskHandler;
    this.#answerHandler = answerHandler;
    this.#gitHandler = gitHandler;
    this.#statusHandler = statusHandler;
    this.#diffHandler = diffHandler;
    this.#testHandler = testHandler;
    this.#stopHandler = stopHandler;
    this.#helpHandler = helpHandler;
    this.#logHandler = logHandler;
    this.#continueHandler = continueHandler;
    this.#dashboard = dashboard;
    this.#confirmationHandler = confirmationHandler;
    this.#commitHandler = commitHandler;
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
    if (this.#confirmationHandler !== undefined) {
      const confirmationHandler = this.#confirmationHandler;
      bot.callbackQuery(/^confirm:(?:allow|deny):[A-Za-z0-9_-]{16,40}$/u, (context) =>
        confirmationHandler.handleCallback(context),
      );
    }
    if (this.#gitHandler !== undefined) {
      const gitHandler = this.#gitHandler;
      bot.command("git", (context) => gitHandler.handleGitCommand(context));
    }
    if (this.#statusHandler !== undefined) {
      const statusHandler = this.#statusHandler;
      bot.command("status", (context) => statusHandler.handleStatusCommand(context));
    }
    if (this.#diffHandler !== undefined) {
      const diffHandler = this.#diffHandler;
      bot.command("diff", (context) => diffHandler.handleDiffCommand(context));
    }
    if (this.#testHandler !== undefined) {
      const testHandler = this.#testHandler;
      bot.command("test", (context) => testHandler.handleTestCommand(context));
    }
    if (this.#stopHandler !== undefined) {
      const stopHandler = this.#stopHandler;
      bot.command("stop", (context) => stopHandler.handleStopCommand(context));
    }
    if (this.#commitHandler !== undefined) {
      const commitHandler = this.#commitHandler;
      bot.command("commit", (context) => commitHandler.handleCommitCommand(context));
    }
    if (this.#helpHandler !== undefined) bot.command("help", (context) => this.#helpHandler?.handleHelpCommand(context));
    if (this.#logHandler !== undefined) bot.command("log", (context) => this.#logHandler?.handleLogCommand(context));
    if (this.#continueHandler !== undefined) bot.command("continue", (context) => this.#continueHandler?.handleContinueCommand(context));
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
    if (this.#dashboard !== undefined) {
      bot.callbackQuery(/^action:[A-Za-z0-9_-]{22}$/u, async (context) => {
        const callback = this.#dashboard?.resolve(context.callbackQuery?.data);
        const userId = context.from?.id;
        const project = userId === undefined ? undefined : await this.#projectHandler.restoreActiveProject(userId);
        if (callback === undefined || project?.id !== callback.projectId ||
          project === undefined || DEFAULT_OPERATION_POLICY.evaluate(project, callback.action).kind === "forbidden") {
          await context.answerCallbackQuery({ text: "This dashboard action is no longer available.", show_alert: true });
          return;
        }
        await context.answerCallbackQuery();
        switch (callback.action) {
          case "task": await this.#taskHandler?.handleTaskCommand(context); break;
          case "status": await this.#statusHandler?.handleStatusCommand(context); break;
          case "git": await this.#gitHandler?.handleGitCommand(context); break;
          case "diff": await this.#diffHandler?.handleDiffCommand(context); break;
          case "test": await this.#testHandler?.handleTestCommand(context); break;
          case "stop": await this.#stopHandler?.handleStopCommand(context); break;
        }
      });
    }
  }
}
