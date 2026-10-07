export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type WebEnvironment = "development" | "production";
export type WebTlsMode = "direct" | "reverse-proxy";

export interface WebConfig {
  readonly enabled: true;
  readonly environment: WebEnvironment;
  readonly host: string;
  readonly port: number;
  readonly publicUrl: string;
  readonly tlsMode: WebTlsMode;
  readonly tlsCertPath?: string;
  readonly tlsKeyPath?: string;
  readonly passwordHash: string;
}

export interface AppConfig {
  readonly telegramEnabled: boolean;
  readonly telegramBotToken: string;
  readonly telegramAllowedUserIds: ReadonlySet<number>;
  readonly webEnabled: boolean;
  readonly web?: WebConfig;
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
