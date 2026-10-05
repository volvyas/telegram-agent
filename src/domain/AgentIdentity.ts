import { createHash } from "node:crypto";

import type { ModelProviderMap, ProjectConfig } from "../config/ProjectConfig.js";

export interface AgentIdentity {
  readonly adapterKind: "codex";
  readonly providerId: string;
  readonly modelId: string;
  readonly providerFingerprint: string;
}

const LEGACY_OPENAI_CONFIG = Object.freeze({
  type: "codex-builtin" as const,
  provider: "openai" as const,
});

export function createAgentIdentity(
  project: ProjectConfig,
  providers: ModelProviderMap = new Map(),
): AgentIdentity {
  const agent = project.agent;
  if (agent === undefined) {
    return identity("openai", "", LEGACY_OPENAI_CONFIG);
  }

  const provider = providers.get(agent.provider);
  return identity(
    agent.provider,
    agent.model,
    provider === undefined
      ? { type: "unavailable", provider: agent.provider }
      : provider,
  );
}

export function legacyOpenAiAgentIdentity(): AgentIdentity {
  return identity("openai", "", LEGACY_OPENAI_CONFIG);
}

function identity(providerId: string, modelId: string, config: unknown): AgentIdentity {
  const normalized = JSON.stringify(config);
  const providerFingerprint = createHash("sha256").update(normalized).digest("hex");
  return Object.freeze({
    adapterKind: "codex",
    providerId,
    modelId,
    providerFingerprint,
  });
}
