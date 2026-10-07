import { resolve } from "node:path";

import { AgentManager } from "../agent/AgentManager.js";
import { CodexAdapter } from "../agent/codex/CodexAdapter.js";
import { ModelProviderResolver } from "../agent/codex/ModelProviderResolver.js";
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
import { GitService } from "../git/GitService.js";
import { GitHandler } from "../telegram/handlers/GitHandler.js";
import { StatusHandler } from "../telegram/handlers/StatusHandler.js";
import { DiffHandler } from "../telegram/handlers/DiffHandler.js";
import { MessageSender } from "../telegram/MessageSender.js";
import { ProjectCommandRunner } from "../process/ProjectCommandRunner.js";
import { TestHandler } from "../telegram/handlers/TestHandler.js";
import { StopHandler } from "../telegram/handlers/StopHandler.js";
import { HelpHandler } from "../telegram/handlers/HelpHandler.js";
import { LogHandler } from "../telegram/handlers/LogHandler.js";
import { ContinueHandler } from "../telegram/handlers/ContinueHandler.js";
import { DashboardKeyboard } from "../telegram/keyboards/DashboardKeyboard.js";
import { TaskManager } from "../tasks/TaskManager.js";
import { ConfirmationService } from "../confirmations/ConfirmationService.js";
import { ConfirmationHandler } from "../telegram/handlers/ConfirmationHandler.js";
import { CommitHandler } from "../telegram/handlers/CommitHandler.js";
import { StructuredLogger } from "../logging/StructuredLogger.js";
import { IssueTrackerResolver } from "../issues/IssueTrackerResolver.js";
import { GitHubIssueTracker } from "../issues/GitHubIssueTracker.js";
import { IssueTrackerHandler } from "../telegram/handlers/IssueTrackerHandler.js";
import { GitHubIssueWriter } from "../issues/GitHubIssueWriter.js";
import { IssueCreationService } from "../issues/IssueCreationService.js";
import { IssueCreationHandler } from "../telegram/handlers/IssueCreationHandler.js";
import { TransportGroup } from "./ApplicationTransport.js";
import { WebServer } from "../web/WebServer.js";
import { WebAuthService } from "../web/WebAuthService.js";
import { WebSessionStore } from "../web/WebSessionStore.js";
import { createWebRouteHandler } from "../web/WebRoutes.js";
import { AgentEventHub } from "../application/AgentEventHub.js";

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
    const modelProviderSecrets = configLoader.loadModelProviderSecrets(projectManager.modelProviders());
    const modelProviderResolver = new ModelProviderResolver(
      projectManager.modelProviders(),
      modelProviderSecrets,
    );
    const issueTrackerSecrets = configLoader.loadIssueTrackerSecrets(projectManager.list());
    const logger = new StructuredLogger({
      level: config.logLevel,
      secrets: [
        config.telegramBotToken,
        ...(config.codexHome === undefined ? [] : [config.codexHome]),
        ...projectManager.list().flatMap((project) => project.codexHome === undefined ? [] : [project.codexHome]),
        ...modelProviderSecrets.redactionValues(),
        ...issueTrackerSecrets.redactionValues(),
      ],
    });
    const dataDirectory = resolve(options.cwd ?? process.cwd(), "data");
    const storage = new JsonStorage(dataDirectory);
    const sessionManager = new SessionManager(storage, projectManager);
    const taskManager = new TaskManager(storage);
    const confirmationService = new ConfirmationService(storage);
    await sessionManager.reconcileInterrupted();
    await taskManager.reconcileInterrupted();
    await confirmationService.expireExpired();
    const environment = { ...(options.environment ?? process.env) };
    const protectedPaths = projectManager.list().map((project) => resolve(project.path, ".git/config"));
    const adapters = new Map(projectManager.list().map((project) => [
      project.id,
      new CodexAdapter({
        environment,
        provider: modelProviderResolver.resolve(project),
        ...(project.codexHome ?? config.codexHome) === undefined
          ? {}
          : { codexHome: project.codexHome ?? config.codexHome },
        protectedPaths,
      }),
    ] as const));
    const progressReporter = new ProgressReporter();
    const eventHub = new AgentEventHub();
    const gitService = new GitService();
    const agentManager = new AgentManager((projectId) => {
      const adapter = adapters.get(projectId);
      if (adapter === undefined) throw new Error("No Codex adapter configured for project");
      return adapter;
    }, projectManager, {
      sessionStore: sessionManager,
      gitService,
      taskStore: taskManager,
      onEvent: (event) => { progressReporter.onEvent(event); eventHub.publish(event); },
    });
    const dashboardKeyboard = new DashboardKeyboard();
    const projectHandler = new ProjectHandler(projectManager, undefined, storage, dashboardKeyboard);
    const answerHandler = new AnswerHandler(agentManager, projectHandler, progressReporter);
    const gitHandler = new GitHandler(projectHandler, gitService);
    const statusHandler = new StatusHandler(projectHandler, agentManager, gitService);
    const diffHandler = new DiffHandler(projectHandler, gitService, new MessageSender());
    const testHandler = new TestHandler(
      projectHandler,
      new ProjectCommandRunner(),
      agentManager,
      new MessageSender(),
    );
    const stopHandler = new StopHandler(projectHandler, agentManager);
    const helpHandler = new HelpHandler();
    const logHandler = new LogHandler(projectHandler, taskManager);
    const confirmationHandler = new ConfirmationHandler(
      confirmationService,
      projectHandler,
    );
    const commitHandler = new CommitHandler(
      projectHandler,
      gitService,
      agentManager,
      confirmationHandler,
    );
    const issueTrackerResolver = new IssueTrackerResolver(
        issueTrackerSecrets,
        (trackerConfig, token) => new GitHubIssueTracker(trackerConfig, token),
        (trackerConfig, token) => new GitHubIssueWriter(trackerConfig, token),
      );
    const issueWriters = new Map<string, import("../issues/IssueWriter.js").IssueWriter>();
    for (const project of projectManager.list()) {
      if (project.issueTracker?.type === "github" && project.issueTracker.allowCreation === true) {
        issueWriters.set(project.id, issueTrackerResolver.resolveWriter(project));
      }
    }
    const issueCreation = new IssueCreationHandler(
      projectHandler,
      confirmationHandler,
      new IssueCreationService(issueWriters, issueTrackerSecrets.redactionValues()),
    );
    const taskHandler = new TaskHandler(agentManager, projectHandler, answerHandler, progressReporter, issueCreation);
    const continueHandler = new ContinueHandler(agentManager, projectHandler, progressReporter, undefined, issueCreation);
    const issueTrackerHandler = new IssueTrackerHandler(
      projectHandler,
      issueTrackerResolver,
    );
    const commandRouter = new CommandRouter(
      projectHandler,
      taskHandler,
      answerHandler,
      gitHandler,
      statusHandler,
      diffHandler,
      testHandler,
      stopHandler,
      helpHandler,
      logHandler,
      continueHandler,
      dashboardKeyboard,
      confirmationHandler,
      commitHandler,
      issueTrackerHandler,
    );
    const telegramBot: ApplicationBot | undefined = config.telegramEnabled
      ? new TelegramBot({
          token: config.telegramBotToken,
          authGuard: new AuthGuard(config.telegramAllowedUserIds),
          commandRouter,
          logger,
        })
      : undefined;
    const webUseCases = {
      projects: {
        list: async () => projectManager.list(),
        select: async (_actor: import("../domain/Actor.js").ActorContext, projectId: string) => projectManager.require(projectId),
      },
      agent: {
        status: async (_actor: import("../domain/Actor.js").ActorContext, projectId: string) => agentManager.getStatus(projectId),
        startTask: async (_actor: import("../domain/Actor.js").ActorContext, projectId: string, prompt: string) => agentManager.startTask(projectId, prompt) as unknown as Promise<import("../storage/Storage.js").PersistedTaskRecord>,
        answer: async (_actor: import("../domain/Actor.js").ActorContext, projectId: string, questionId: string, answer: string) => agentManager.answerQuestion(projectId, questionId, answer) as unknown as Promise<import("../storage/Storage.js").PersistedTaskRecord>,
        stop: async (_actor: import("../domain/Actor.js").ActorContext, projectId: string) => agentManager.stop(projectId),
        events: async function* () { /* SSE is fed by the process-local event hub. */ },
      },
      git: {
        status: async (_actor: import("../domain/Actor.js").ActorContext, projectId: string) => gitService.getStatus(projectManager.require(projectId).path),
        diff: async (_actor: import("../domain/Actor.js").ActorContext, projectId: string) => gitService.getDiff(projectManager.require(projectId).path),
        log: async () => ({ entries: [] }),
      },
      test: { run: async () => ({ status: "not_configured" }) },
      confirmations: { request: async () => ({ error: "not_configured" }), consume: async () => ({ error: "not_configured" }) },
    } satisfies import("../application/UseCases.js").ApplicationUseCases;
    const webServer = config.webEnabled && config.web !== undefined
      ? new WebServer({ config: config.web, auth: new WebAuthService(config.web.passwordHash, new WebSessionStore()), staticDirectory: resolve(options.cwd ?? process.cwd(), "src/web/public"), eventHub, requestHandler: createWebRouteHandler(webUseCases) })
      : undefined;
    const bot: ApplicationBot = new TransportGroup([
      ...(telegramBot === undefined ? [] : [telegramBot]),
      ...(webServer === undefined ? [] : [webServer]),
    ]);

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
