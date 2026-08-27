export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  readonly telegramBotToken: string;
  readonly telegramAllowedUserIds: ReadonlySet<number>;
  readonly projectsConfigPath: string;
  readonly logLevel: LogLevel;
  readonly codexHome?: string;
}

export class ConfigError extends Error {
  public readonly code: string;
  public readonly variableName?: string;

  public constructor(
    code: string,
    message: string,
    options?: ErrorOptions & { readonly variableName?: string },
  ) {
    super(message, options);
    this.name = "ConfigError";
    this.code = code;
    if (options?.variableName !== undefined) {
      this.variableName = options.variableName;
    }
  }
}
