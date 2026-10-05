import type { ModelProviderConfig, ModelProviderMap, ProjectConfig } from "../../config/ProjectConfig.js";
import type { ModelProviderSecrets } from "../../config/ConfigLoader.js";

export interface CodexProviderConfigValue {
  readonly model_provider: string;
  readonly model_providers?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface ProviderCredential {
  readonly environmentName: string;
  readonly value: string;
}

export interface ResolvedCodexProvider {
  readonly providerId: string;
  readonly model?: string;
  readonly config: CodexProviderConfigValue;
  readonly credential?: ProviderCredential;
}

export class ModelProviderResolverError extends Error {
  public readonly code: string;
  public readonly providerId?: string;

  public constructor(
    code: string,
    message: string,
    options?: ErrorOptions & { readonly providerId?: string },
  ) {
    super(message, options);
    this.name = "ModelProviderResolverError";
    this.code = code;
    if (options?.providerId !== undefined) this.providerId = options.providerId;
  }
}

export class ModelProviderResolver {
  readonly #providers: ModelProviderMap;
  readonly #secrets: ModelProviderSecrets;

  public constructor(providers: ModelProviderMap, secrets: ModelProviderSecrets) {
    this.#providers = new Map(providers);
    this.#secrets = secrets;
  }

  public resolve(project: ProjectConfig): ResolvedCodexProvider {
    const agent = project.agent;
    if (agent === undefined) {
      return Object.freeze({
        providerId: "openai",
        config: Object.freeze({ model_provider: "openai" }),
      });
    }

    const provider = this.#providers.get(agent.provider);
    if (provider === undefined) {
      throw new ModelProviderResolverError(
        "MODEL_PROVIDER_REFERENCE_UNKNOWN",
        "Project references an unavailable model provider",
        { providerId: agent.provider },
      );
    }

    return Object.freeze({
      providerId: agent.provider,
      model: agent.model,
      config: createProviderConfig(agent.provider, provider),
      ...(provider.type === "responses" && provider.apiKeyEnv !== undefined
        ? { credential: this.resolveCredential(agent.provider, provider.apiKeyEnv) }
        : {}),
    });
  }

  resolveAll(projects: readonly ProjectConfig[]): ReadonlyMap<string, ResolvedCodexProvider> {
    return new Map(projects.map((project) => [project.id, this.resolve(project)] as const));
  }

  private resolveCredential(providerId: string, environmentName: string): ProviderCredential {
    const value = this.#secrets.getApiKey(providerId);
    if (value === undefined) {
      throw new ModelProviderResolverError(
        "MODEL_PROVIDER_CREDENTIAL_REQUIRED",
        "Referenced model provider credential is unavailable",
        { providerId },
      );
    }
    return Object.freeze({ environmentName, value });
  }
}

function createProviderConfig(
  providerId: string,
  provider: ModelProviderConfig,
): CodexProviderConfigValue {
  if (provider.type === "codex-builtin") {
    return Object.freeze({ model_provider: provider.provider });
  }

  const providerDefinition: Record<string, string> = {
    name: provider.name,
    base_url: provider.baseUrl,
    wire_api: provider.wireApi,
  };
  if (provider.apiKeyEnv !== undefined) providerDefinition.env_key = provider.apiKeyEnv;

  return Object.freeze({
    model_provider: providerId,
    model_providers: Object.freeze({
      [providerId]: Object.freeze(providerDefinition),
    }),
  });
}
