import { describe, expect, it } from "vitest";

import { ModelProviderSecrets } from "../../../src/config/ConfigLoader.js";
import { ModelProviderResolver } from "../../../src/agent/codex/ModelProviderResolver.js";
import type { ProjectConfig } from "../../../src/config/ProjectConfig.js";

function project(agent?: ProjectConfig["agent"]): ProjectConfig {
  return {
    id: "motor",
    name: "Motor",
    path: "/projects/motor",
    allowedOperations: new Set(["task"]),
    ...(agent === undefined ? {} : { agent }),
  };
}

describe("ModelProviderResolver", () => {
  it("maps a per-model context budget and preserves legacy defaults for other projects", () => {
    const resolver = new ModelProviderResolver(new Map([["local", {
      type: "responses", name: "Local", baseUrl: "http://127.0.0.1:8080/v1", wireApi: "responses",
    }]]), new ModelProviderSecrets(new Map()));
    const resolved = resolver.resolve(project({ provider: "local", model: "qwen", context: {
      windowTokens: 32768, outputReserveTokens: 4096, safetyMarginTokens: 2048,
    } }));
    expect(resolved.config).toMatchObject({ model_context_window: 32768, model_auto_compact_token_limit: 26624 });
    expect(resolver.resolve(project({ provider: "local", model: "another-model" })).config.model_context_window).toBeUndefined();
    expect(resolver.resolve(project()).config.model_auto_compact_token_limit).toBeUndefined();
  });

  it("caps the compaction threshold at 90 percent when configured reserves are smaller", () => {
    const resolver = new ModelProviderResolver(new Map([["local", { type: "codex-builtin", provider: "ollama" }]]), new ModelProviderSecrets(new Map()));
    expect(resolver.resolve(project({ provider: "local", model: "model", context: {
      windowTokens: 10000, outputReserveTokens: 100, safetyMarginTokens: 100,
    } })).config.model_auto_compact_token_limit).toBe(9000);
  });

  it.each([
    ["openai", { type: "codex-builtin", provider: "openai" }],
    ["ollama", { type: "codex-builtin", provider: "ollama" }],
    ["lmstudio", { type: "codex-builtin", provider: "lmstudio" }],
  ] as const)("maps built-in provider %s", (id, provider) => {
    const resolver = new ModelProviderResolver(
      new Map([[id, provider]]),
      new ModelProviderSecrets(new Map()),
    );

    expect(resolver.resolve(project({ provider: id, model: "model-1" }))).toEqual({
      providerId: id,
      model: "model-1",
      config: { model_provider: provider.provider },
    });
  });

  it("maps a custom Responses provider without leaking the credential", () => {
    const resolver = new ModelProviderResolver(
      new Map([["home", {
        type: "responses",
        name: "Home",
        baseUrl: "http://192.168.1.179:8080/v1",
        wireApi: "responses",
        apiKeyEnv: "HOME_MODEL_KEY",
      }]]),
      new ModelProviderSecrets(new Map([["home", "secret-value"]])),
    );

    const resolved = resolver.resolve(project({ provider: "home", model: "qwen" }));

    expect(resolved).toEqual({
      providerId: "home",
      model: "qwen",
      config: {
        model_provider: "home",
        model_providers: {
          home: {
            name: "Home",
            base_url: "http://192.168.1.179:8080/v1",
            wire_api: "responses",
            env_key: "HOME_MODEL_KEY",
          },
        },
      },
      credential: { environmentName: "HOME_MODEL_KEY", value: "secret-value" },
    });
    expect(JSON.stringify(resolved.config)).not.toContain("secret-value");
  });

  it("preserves legacy OpenAI behavior when agent is absent", () => {
    const resolved = new ModelProviderResolver(
      new Map(),
      new ModelProviderSecrets(new Map()),
    ).resolve(project());

    expect(resolved).toEqual({
      providerId: "openai",
      config: { model_provider: "openai" },
    });
  });

  it("keeps provider-specific resolutions isolated", () => {
    const resolver = new ModelProviderResolver(
      new Map([
        ["one", { type: "responses", name: "One", baseUrl: "http://127.0.0.1:1/v1", wireApi: "responses" }],
        ["two", { type: "codex-builtin", provider: "ollama" }],
      ]),
      new ModelProviderSecrets(new Map()),
    );

    const first = resolver.resolve(project({ provider: "one", model: "first" }));
    const second = resolver.resolve({ ...project({ provider: "two", model: "second" }), id: "other" });

    expect(first.config.model_provider).toBe("one");
    expect(second.config.model_provider).toBe("ollama");
    expect(first.model).toBe("first");
    expect(second.model).toBe("second");
  });
});
