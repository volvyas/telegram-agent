import {
  Bot,
  BotError,
  type BotConfig,
  type Context,
} from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import type { Update } from "grammy/types";

import type { AuthGuard } from "./AuthGuard.js";
import type { CommandRouter } from "./CommandRouter.js";
import { createDiagnosticId } from "../errors/TelegramError.js";

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

    this.#bot.catch(async (error) => {
      const diagnosticId = createDiagnosticId();
      options.logger?.error(telegramFailureMessage(diagnosticId), { diagnosticId });
      // Polling runner errors otherwise only reach the logger, leaving the
      // user with a silent update. Keep the response generic and correlate it
      // with the redacted diagnostic entry.
      if (error instanceof BotError) {
        try {
          await error.ctx.reply(`Unable to process this request. Reference: ${diagnosticId}.`);
        } catch {
          // The original failure may be a Telegram API outage as well.
        }
      }
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
    } catch (_error) {
      const diagnosticId = createDiagnosticId();
      this.#logger?.error(telegramFailureMessage(diagnosticId), { diagnosticId });
      await this.#notifyFailure(update, diagnosticId);
    }
  }

  async #notifyFailure(update: Update, diagnosticId: string): Promise<void> {
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId === undefined) return;
    try {
      await this.#bot.api.sendMessage(chatId, `Unable to process this request. Reference: ${diagnosticId}.`);
    } catch {
      // The Telegram API may be the source of the original failure.
    }
  }
}

function telegramFailureMessage(diagnosticId: string): string {
  return `Telegram update handling failed Reference: ${diagnosticId}.`;
}
