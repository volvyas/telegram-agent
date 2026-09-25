import {
  Bot,
  type BotConfig,
  type Context,
} from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import type { Update } from "grammy/types";

import type { AuthGuard } from "./AuthGuard.js";
import type { CommandRouter } from "./CommandRouter.js";
import { createDiagnosticId, formatTelegramError } from "../errors/TelegramError.js";

export interface TelegramBotLogger {
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface TelegramBotOptions {
  readonly token: string;
  readonly authGuard: AuthGuard;
  readonly commandRouter: CommandRouter;
  readonly botConfig?: BotConfig<Context>;
  readonly logger?: TelegramBotLogger;
}

export class TelegramBot {
  readonly #bot: Bot;
  readonly #logger: TelegramBotLogger | undefined;
  #runner: RunnerHandle | undefined;

  public constructor(options: TelegramBotOptions) {
    this.#bot = new Bot(options.token, options.botConfig);
    this.#logger = options.logger;

    // Authentication must remain the first middleware in the update chain.
    this.#bot.use(options.authGuard.middleware());
    options.commandRouter.register(this.#bot);

    this.#bot.catch((error) => {
      const diagnosticId = createDiagnosticId();
      options.logger?.error(formatTelegramError(error, "Telegram update handling failed"), { diagnosticId });
    });
  }

  public start(): Promise<void> {
    if (this.#runner?.isRunning() === true) {
      throw new Error("Telegram bot is already running");
    }
    const runner = run(this.#bot, { sink: { concurrency: 16 } });
    this.#runner = runner;
    return runner.task() ?? Promise.resolve();
  }

  public async stop(): Promise<void> {
    const runner = this.#runner;
    if (runner === undefined) return;
    await runner.stop();
    if (this.#runner === runner) this.#runner = undefined;
  }

  public async handleUpdate(update: Update): Promise<void> {
    try {
      await this.#bot.handleUpdate(update);
    } catch (error) {
      const diagnosticId = createDiagnosticId();
      this.#logger?.error(formatTelegramError(error, "Telegram update handling failed"), { diagnosticId });
    }
  }
}
