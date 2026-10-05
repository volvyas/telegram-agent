import { Codex, type CodexOptions } from "@openai/codex-sdk";

import type { ResolvedCodexProvider } from "./ModelProviderResolver.js";
import {
  createCodexEnvironment,
  type CodexClientPort,
  type SafeCodexThreadOptions,
} from "./CodexAdapter.js";

export interface CodexClientFactoryOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly codexHome?: string;
  readonly protectedPaths: readonly string[];
  readonly provider: ResolvedCodexProvider;
}

export interface CodexClientFactoryPort {
  create(options: CodexClientFactoryOptions): CodexClientPort;
}

export class CodexClientFactory implements CodexClientFactoryPort {
  public create(options: CodexClientFactoryOptions): CodexClientPort {
    const credential = options.provider.credential;
    const environment = createCodexEnvironment(
      options.environment,
      options.codexHome,
      credential,
    );
    return new SdkCodexClient(
      environment,
      options.protectedPaths,
      options.provider.config,
    );
  }
}

class SdkCodexClient implements CodexClientPort {
  readonly #client: Codex;

  public constructor(
    environment: Readonly<Record<string, string>>,
    protectedPaths: readonly string[],
    providerConfig: ResolvedCodexProvider["config"],
  ) {
    this.#client = new Codex({
      env: { ...environment },
      config: providerConfig as unknown as NonNullable<CodexOptions["config"]>,
      configOverrides: [createFilesystemPolicy(protectedPaths)],
    });
  }

  public startThread(options: SafeCodexThreadOptions): import("./CodexAdapter.js").CodexThreadPort {
    return this.#client.startThread(toSdkThreadOptions(options));
  }

  public resumeThread(
    threadId: string,
    options: SafeCodexThreadOptions,
  ): import("./CodexAdapter.js").CodexThreadPort {
    return this.#client.resumeThread(threadId, toSdkThreadOptions(options));
  }
}

function createFilesystemPolicy(protectedPaths: readonly string[]): string {
  const entries = [
    [":root", "read"],
    ...protectedPaths.map((path) => [path, "deny"] as const),
  ];
  const filesystem = entries
    .map(([path, permission]) => `${JSON.stringify(path)}=${JSON.stringify(permission)}`)
    .join(",");
  return `permissions.audit.filesystem={${filesystem}}`;
}

function toSdkThreadOptions(options: SafeCodexThreadOptions) {
  return {
    ...options,
    additionalDirectories: [...options.additionalDirectories],
  };
}
