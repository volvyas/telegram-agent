import {
  Bot,
  type BotConfig,
  type Context,
  type PollingOptions,
} from "grammy";
import type { Update } from "grammy/types";

import type { AuthGuard } from "./AuthGuard.js";
import type { CommandRouter } from "./CommandRouter.js";

export interface TelegramBotLogger {
  error(message: string): void;
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

  public constructor(options: TelegramBotOptions) {
    this.#bot = new Bot(options.token, options.botConfig);
    this.#logger = options.logger;

    // Authentication must remain the first middleware in the update chain.
    this.#bot.use(options.authGuard.middleware());
    options.commandRouter.register(this.#bot);

    this.#bot.catch(() => {
      options.logger?.error("Telegram update handling failed.");
    });
  }

  public start(options?: PollingOptions): Promise<void> {
    return this.#bot.start(options);
  }

  public stop(): Promise<void> {
    return this.#bot.stop();
  }

  public async handleUpdate(update: Update): Promise<void> {
    try {
      await this.#bot.handleUpdate(update);
    } catch {
      this.#logger?.error("Telegram update handling failed.");
    }
  }
}
