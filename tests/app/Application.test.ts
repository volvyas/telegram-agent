import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Application,
  type ShutdownSignal,
  type SignalSource,
} from "../../src/app/Application.js";
import { allowEnvironment, ProcessRunner } from "../../src/process/ProcessRunner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Application", () => {
  it("stops active agent runs before stopping Telegram on a shutdown signal", async () => {
    const callOrder: string[] = [];
    const signals = new FakeSignals();
    let finishPolling: (() => void) | undefined;
    const polling = new Promise<void>((resolve) => {
      finishPolling = resolve;
    });
    const bot = {
      start: vi.fn(() => polling),
      stop: vi.fn(() => {
        callOrder.push("bot");
        finishPolling?.();
        return Promise.resolve();
      }),
    };
    const agentManager = {
      stopAll: vi.fn(() => {
        callOrder.push("agents");
        return Promise.resolve();
      }),
    };
    const storage = {
      close: vi.fn(() => {
        callOrder.push("storage");
        return Promise.resolve();
      }),
    };
    const application = new Application({ agentManager, bot, storage, signals });

    const running = application.start();
    signals.emit("SIGTERM");
    await running;

    expect(callOrder).toEqual(["agents", "bot", "storage"]);
    expect(signals.listenerCount()).toBe(0);
  });

  it("makes concurrent shutdown requests idempotent", async () => {
    const bot = {
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
    };
    const agentManager = { stopAll: vi.fn(() => Promise.resolve()) };
    const application = new Application({ agentManager, bot, signals: new FakeSignals() });

    await Promise.all([application.shutdown(), application.shutdown()]);

    expect(agentManager.stopAll).toHaveBeenCalledOnce();
    expect(bot.stop).not.toHaveBeenCalled();
  });

  it("composes Phase 1 from validated environment and project configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-remote-application-test-"));
    temporaryDirectories.push(root);
    const repository = join(root, "project");
    await mkdir(repository);
    const git = await new ProcessRunner().run({
      executable: "git",
      args: ["init", "-q", "-b", "main"],
      cwd: repository,
      env: allowEnvironment(process.env, ["PATH", "LANG", "LC_ALL"]),
    });
    expect(git.exitCode).toBe(0);
    const projectsConfigPath = join(root, "projects.json");
    await writeFile(projectsConfigPath, JSON.stringify({
      modelProviders: {
        offline: {
          type: "responses",
          name: "Offline provider",
          baseUrl: "http://192.168.1.179:8080/v1",
          wireApi: "responses",
        },
      },
      projects: {
        demo: {
          name: "Demo",
          path: repository,
          agent: { provider: "offline", model: "offline-model" },
          allowedOperations: ["task"],
        },
      },
    }));

    const application = await Application.create({
      environment: {
        TELEGRAM_BOT_TOKEN: "123456:test-token",
        TELEGRAM_ALLOWED_USER_IDS: "42",
        PROJECTS_CONFIG: projectsConfigPath,
        PATH: process.env.PATH,
      },
      cwd: root,
      signals: new FakeSignals(),
    });

    expect(application).toBeInstanceOf(Application);
    await application.shutdown();
  });
});

class FakeSignals implements SignalSource {
  readonly #listeners = new Map<ShutdownSignal, Set<() => void>>();

  public on(signal: ShutdownSignal, listener: () => void): void {
    const listeners = this.#listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(signal, listeners);
  }

  public off(signal: ShutdownSignal, listener: () => void): void {
    this.#listeners.get(signal)?.delete(listener);
  }

  public emit(signal: ShutdownSignal): void {
    for (const listener of this.#listeners.get(signal) ?? []) {
      listener();
    }
  }

  public listenerCount(): number {
    return [...this.#listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}
