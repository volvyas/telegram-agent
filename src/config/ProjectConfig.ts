import type { IssueTrackerConfig } from "./IssueTrackerConfig.js";

export const ALLOWED_OPERATIONS = [
  "task",
  "status",
  "git",
  "diff",
  "test",
  "build",
  "run",
  "stop",
  "commit",
] as const;

export type AllowedOperation = (typeof ALLOWED_OPERATIONS)[number];

export const CODEX_BUILTIN_PROVIDERS = ["openai", "ollama", "lmstudio"] as const;
export type CodexBuiltinProvider = (typeof CODEX_BUILTIN_PROVIDERS)[number];

export interface CodexBuiltinProviderConfig {
  readonly type: "codex-builtin";
  readonly provider: CodexBuiltinProvider;
}

export interface ResponsesProviderConfig {
  readonly type: "responses";
  readonly name: string;
  readonly baseUrl: string;
  readonly wireApi: "responses";
  readonly apiKeyEnv?: string;
}

export type ModelProviderConfig =
  | CodexBuiltinProviderConfig
  | ResponsesProviderConfig;

export type ModelProviderMap = ReadonlyMap<string, ModelProviderConfig>;

export interface ProjectAgentConfig {
  readonly provider: string;
  readonly model: string;
  readonly context?: AgentContextConfig;
}

/** Per project/provider/model: reserve is budgeting headroom, not a generation cap. */
export interface AgentContextConfig {
  readonly windowTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyMarginTokens: number;
}

export const MODEL_PROVIDER_RUNTIME_DEFAULTS = Object.freeze({
  requestRetries: 2,
  streamRetries: 2,
  idleTimeoutMs: 30_000,
} as const);

export interface ProjectCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface ProjectConfig {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** Optional project-specific Codex profile; otherwise the app default is used. */
  readonly codexHome?: string;
  readonly agent?: ProjectAgentConfig;
  readonly allowedOperations: ReadonlySet<AllowedOperation>;
  readonly testCommand?: ProjectCommand;
  readonly buildCommand?: ProjectCommand;
  readonly runCommand?: ProjectCommand;
  readonly branch?: string;
  readonly issueTracker?: IssueTrackerConfig;
}

export class ProjectConfigError extends Error {
  public readonly code: string;
  public readonly projectId?: string;

  public constructor(
    code: string,
    message: string,
    options?: ErrorOptions & { readonly projectId?: string },
  ) {
    super(message, options);
    this.name = "ProjectConfigError";
    this.code = code;
    if (options?.projectId !== undefined) {
      this.projectId = options.projectId;
    }
  }
}
