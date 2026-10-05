import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  ConfigError,
  LOG_LEVELS,
  type AppConfig,
  type LogLevel,
} from "./AppConfig.js";
import { IssueTrackerSecrets } from "./IssueTrackerConfig.js";
import type {
  ModelProviderMap,
  ProjectConfig,
} from "./ProjectConfig.js";

const DEFAULT_PROJECTS_CONFIG = "./projects.json";
const DEFAULT_LOG_LEVEL: LogLevel = "info";

export interface ProcessConfigLoaderOptions {
  readonly cwd?: string;
  readonly envFilePath?: string;
}

export class ModelProviderSecrets {
  readonly #apiKeys: ReadonlyMap<string, string>;

  public constructor(apiKeys: ReadonlyMap<string, string>) {
    this.#apiKeys = new Map(apiKeys);
  }

  public getApiKey(providerId: string): string | undefined {
    return this.#apiKeys.get(providerId);
  }

  public redactionValues(): readonly string[] {
    return Object.freeze([...this.#apiKeys.values()]);
  }

  public toJSON(): Record<string, never> {
    return {};
  }
}

export class ConfigLoader {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #cwd: string;

  public constructor(environment: NodeJS.ProcessEnv, cwd = process.cwd()) {
    this.#environment = { ...environment };
    this.#cwd = resolve(cwd);
  }

  public static fromProcess(options: ProcessConfigLoaderOptions = {}): ConfigLoader {
    const cwd = resolve(options.cwd ?? process.cwd());
    const envFilePath = resolve(cwd, options.envFilePath ?? ".env");

    if (existsSync(envFilePath)) {
      try {
        process.loadEnvFile(envFilePath);
      } catch (error) {
        throw new ConfigError(
          "ENV_FILE_INVALID",
          "Unable to load environment file",
          { cause: error },
        );
      }
    }

    return new ConfigLoader(process.env, cwd);
  }

  public loadAppConfig(): AppConfig {
    const telegramBotToken = requireNonEmpty(
      this.#environment.TELEGRAM_BOT_TOKEN,
      "TELEGRAM_BOT_TOKEN",
    );
    validateTelegramToken(telegramBotToken);

    const telegramAllowedUserIds = parseAllowedUserIds(
      this.#environment.TELEGRAM_ALLOWED_USER_IDS,
    );
    const configuredProjectsPath = this.#environment.PROJECTS_CONFIG?.trim();
    const projectsConfigPath = resolve(
      this.#cwd,
      configuredProjectsPath === undefined || configuredProjectsPath.length === 0
        ? DEFAULT_PROJECTS_CONFIG
        : configuredProjectsPath,
    );
    const logLevel = parseLogLevel(this.#environment.LOG_LEVEL);
    const codexHome = parseOptionalAbsolutePath(
      this.#environment.CODEX_HOME,
      "CODEX_HOME",
    );

    const baseConfig = {
      telegramBotToken,
      telegramAllowedUserIds,
      projectsConfigPath,
      logLevel,
    };

    return Object.freeze(
      codexHome === undefined ? baseConfig : { ...baseConfig, codexHome },
    );
  }

  public async loadProjectsDocument(config: AppConfig): Promise<unknown> {
    let content: string;
    try {
      content = await readFile(config.projectsConfigPath, "utf8");
    } catch (error) {
      throw new ConfigError(
        "PROJECTS_CONFIG_UNREADABLE",
        "Unable to read projects configuration",
        { cause: error, variableName: "PROJECTS_CONFIG" },
      );
    }

    try {
      return JSON.parse(content) as unknown;
    } catch (error) {
      throw new ConfigError(
        "PROJECTS_CONFIG_INVALID_JSON",
        "Projects configuration is not valid JSON",
        { cause: error, variableName: "PROJECTS_CONFIG" },
      );
    }
  }

  /** Resolves provider credentials without adding them to typed project config. */
  public loadModelProviderSecrets(providers: ModelProviderMap): ModelProviderSecrets {
    const apiKeys = new Map<string, string>();
    for (const [providerId, provider] of providers) {
      if (provider.type !== "responses" || provider.apiKeyEnv === undefined) continue;
      const value = this.#environment[provider.apiKeyEnv]?.trim();
      if (value === undefined || value.length === 0) {
        throw new ConfigError(
          "MODEL_PROVIDER_CREDENTIAL_REQUIRED",
          `Required model provider credential for ${providerId} is missing`,
          { variableName: provider.apiKeyEnv },
        );
      }
      apiKeys.set(providerId, value);
    }
    return new ModelProviderSecrets(apiKeys);
  }

  /** Resolves tracker credentials after project configuration has been validated. */
  public loadIssueTrackerSecrets(
    projects: readonly ProjectConfig[],
  ): IssueTrackerSecrets {
    const tokens = new Map<string, string>();
    const writeTokens = new Map<string, string>();
    for (const project of projects) {
      if (project.issueTracker?.type !== "github") continue;
      const token = this.#environment[project.issueTracker.tokenEnv]?.trim();
      if (token === undefined || token.length === 0) {
        throw new ConfigError(
          "ISSUE_TRACKER_CREDENTIAL_REQUIRED",
          `Required issue tracker credential for project ${project.id} is missing`,
          { variableName: project.issueTracker.tokenEnv },
        );
      }
      tokens.set(project.id, token);
      if (project.issueTracker.allowCreation === true) {
        const writeTokenEnv = project.issueTracker.writeTokenEnv;
        const writeToken = writeTokenEnv === undefined ? undefined : this.#environment[writeTokenEnv]?.trim();
        if (writeTokenEnv === undefined || writeToken === undefined || writeToken.length === 0) {
          throw new ConfigError("ISSUE_TRACKER_WRITE_CREDENTIAL_REQUIRED", `Required issue tracker write credential for project ${project.id} is missing`, writeTokenEnv === undefined ? {} : { variableName: writeTokenEnv });
        }
        writeTokens.set(project.id, writeToken);
      }
    }
    return new IssueTrackerSecrets(tokens, writeTokens);
  }
}

function requireNonEmpty(value: string | undefined, variableName: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    throw new ConfigError(
      "ENV_REQUIRED",
      `Required environment variable ${variableName} is missing`,
      { variableName },
    );
  }
  return normalized;
}

function validateTelegramToken(token: string): void {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new ConfigError(
      "TELEGRAM_TOKEN_INVALID",
      "TELEGRAM_BOT_TOKEN has an invalid format",
      { variableName: "TELEGRAM_BOT_TOKEN" },
    );
  }
}

function parseAllowedUserIds(value: string | undefined): ReadonlySet<number> {
  const raw = requireNonEmpty(value, "TELEGRAM_ALLOWED_USER_IDS");
  const ids = new Set<number>();

  for (const part of raw.split(",")) {
    const normalized = part.trim();
    if (!/^\d+$/.test(normalized)) {
      throw invalidAllowedUserIds();
    }

    const id = Number(normalized);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw invalidAllowedUserIds();
    }
    ids.add(id);
  }

  if (ids.size === 0) {
    throw invalidAllowedUserIds();
  }
  return ids;
}

function invalidAllowedUserIds(): ConfigError {
  return new ConfigError(
    "TELEGRAM_ALLOWED_USER_IDS_INVALID",
    "TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of positive integers",
    { variableName: "TELEGRAM_ALLOWED_USER_IDS" },
  );
}

function parseLogLevel(value: string | undefined): LogLevel {
  const configuredLevel = value?.trim();
  const normalized =
    configuredLevel === undefined || configuredLevel.length === 0
      ? DEFAULT_LOG_LEVEL
      : configuredLevel;
  if (isLogLevel(normalized)) {
    return normalized;
  }

  throw new ConfigError(
    "LOG_LEVEL_INVALID",
    `LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`,
    { variableName: "LOG_LEVEL" },
  );
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function parseOptionalAbsolutePath(
  value: string | undefined,
  variableName: string,
): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }
  if (!isAbsolute(normalized)) {
    throw new ConfigError(
      "ENV_PATH_NOT_ABSOLUTE",
      `${variableName} must be an absolute path`,
      { variableName },
    );
  }
  return resolve(normalized);
}
