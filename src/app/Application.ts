import { resolve } from "node:path";

import { AgentManager } from "../agent/AgentManager.js";
import { CodexAdapter } from "../agent/codex/CodexAdapter.js";
import { ConfigLoader } from "../config/ConfigLoader.js";
import { ProjectManager } from "../projects/ProjectManager.js";
import { SessionManager } from "../sessions/SessionManager.js";
import { JsonStorage } from "../storage/JsonStorage.js";
import { AuthGuard } from "../telegram/AuthGuard.js";
import { CommandRouter } from "../telegram/CommandRouter.js";
import { TelegramBot } from "../telegram/TelegramBot.js";
import { ProjectHandler } from "../telegram/handlers/ProjectHandler.js";
import { TaskHandler } from "../telegram/handlers/TaskHandler.js";
import { AnswerHandler } from "../telegram/handlers/AnswerHandler.js";
import { ProgressReporter } from "../telegram/ProgressReporter.js";

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): void;
  off(signal: ShutdownSignal, listener: () => void): void;
}

export interface ApplicationAgentManager {
  stopAll(): Promise<void>;
}

export interface ApplicationBot {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ApplicationStorage {
  close(): Promise<void>;
}

export interface ApplicationDependencies {
  readonly agentManager: ApplicationAgentManager;
  readonly bot: ApplicationBot;
  readonly storage?: ApplicationStorage;
  readonly signals?: SignalSource;
}

export interface ApplicationCreateOptions {
  readonly configLoader?: ConfigLoader;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly signals?: SignalSource;
}

export class Application {
  readonly #agentManager: ApplicationAgentManager;
  readonly #bot: ApplicationBot;
  readonly #storage: ApplicationStorage | undefined;
  readonly #signals: SignalSource;
  readonly #signalHandlers = new Map<ShutdownSignal, () => void>();
  #started = false;
  #shutdownPromise: Promise<void> | undefined;

  public constructor(dependencies: ApplicationDependencies) {
    this.#agentManager = dependencies.agentManager;
    this.#bot = dependencies.bot;
    this.#storage = dependencies.storage;
    this.#signals = dependencies.signals ?? process;
  }

  public static async create(options: ApplicationCreateOptions = {}): Promise<Application> {
    const configLoader =
      options.configLoader ??
      (options.environment === undefined
        ? ConfigLoader.fromProcess({
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          })
        : new ConfigLoader(options.environment, options.cwd ?? process.cwd()));
    const config = configLoader.loadAppConfig();
    const projectsDocument = await configLoader.loadProjectsDocument(config);
    const projectManager = await ProjectManager.fromDocument(projectsDocument);
    const dataDirectory = resolve(options.cwd ?? process.cwd(), "data");
    const storage = new JsonStorage(dataDirectory);
    const sessionManager = new SessionManager(storage, projectManager);
    const environment = { ...(options.environment ?? process.env) };
    const adapter = new CodexAdapter({
      environment,
      ...(config.codexHome === undefined ? {} : { codexHome: config.codexHome }),
    });
    const progressReporter = new ProgressReporter();
    const agentManager = new AgentManager(adapter, projectManager, {
      sessionStore: sessionManager,
      onEvent: (event) => progressReporter.onEvent(event),
    });
    const projectHandler = new ProjectHandler(projectManager, undefined, storage);
    const answerHandler = new AnswerHandler(agentManager, projectHandler, progressReporter);
    const taskHandler = new TaskHandler(agentManager, projectHandler, answerHandler, progressReporter);
    const commandRouter = new CommandRouter(projectHandler, taskHandler, answerHandler);
    const bot = new TelegramBot({
      token: config.telegramBotToken,
      authGuard: new AuthGuard(config.telegramAllowedUserIds),
      commandRouter,
      logger: console,
    });

    return new Application({
      agentManager,
      bot,
      storage,
      ...(options.signals === undefined ? {} : { signals: options.signals }),
    });
  }

  public async start(): Promise<void> {
    if (this.#started) {
      throw new Error("Application is already started");
    }
    this.#started = true;
    this.#registerSignalHandlers();

    try {
      await this.#bot.start();
    } finally {
      this.#removeSignalHandlers();
      this.#started = false;
    }
  }

  public shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#performShutdown();
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<void> {
    try {
      await this.#agentManager.stopAll();
    } finally {
      try {
        if (this.#started) {
          await this.#bot.stop();
        }
      } finally {
        await this.#storage?.close();
      }
    }
  }

  #registerSignalHandlers(): void {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        void this.shutdown().catch(() => undefined);
      };
      this.#signalHandlers.set(signal, handler);
      this.#signals.on(signal, handler);
    }
  }

  #removeSignalHandlers(): void {
    for (const [signal, handler] of this.#signalHandlers) {
      this.#signals.off(signal, handler);
    }
    this.#signalHandlers.clear();
  }
}
