import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigError } from "../../src/config/AppConfig.js";
import { ConfigLoader } from "../../src/config/ConfigLoader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("ConfigLoader", () => {
  it("loads an optional .env file through the Node.js environment loader", async () => {
    const cwd = await createTemporaryDirectory();
    await writeFile(
      join(cwd, ".env"),
      [
        "TELEGRAM_BOT_TOKEN=321:file_token",
        "TELEGRAM_ALLOWED_USER_IDS=99",
        "LOG_LEVEL=warn",
      ].join("\n"),
    );
    const original = snapshotEnvironment([
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_IDS",
      "LOG_LEVEL",
    ]);

    try {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
      delete process.env.LOG_LEVEL;

      const config = ConfigLoader.fromProcess({ cwd }).loadAppConfig();

      expect(config.telegramBotToken).toBe("321:file_token");
      expect([...config.telegramAllowedUserIds]).toEqual([99]);
      expect(config.logLevel).toBe("warn");
    } finally {
      restoreEnvironment(original);
    }
  });

  it("loads and normalizes a valid environment", async () => {
    const cwd = await createTemporaryDirectory();
    const loader = new ConfigLoader(
      {
        TELEGRAM_BOT_TOKEN: " 123456:abc_DEF-ghi ",
        TELEGRAM_ALLOWED_USER_IDS: "42, 84,42",
        PROJECTS_CONFIG: "config/projects.json",
        LOG_LEVEL: "debug",
        CODEX_HOME: "/var/lib/codex-remote/codex-home",
      },
      cwd,
    );

    const config = loader.loadAppConfig();

    expect(config.telegramBotToken).toBe("123456:abc_DEF-ghi");
    expect([...config.telegramAllowedUserIds]).toEqual([42, 84]);
    expect(config.projectsConfigPath).toBe(join(cwd, "config/projects.json"));
    expect(config.logLevel).toBe("debug");
    expect(config.codexHome).toBe("/var/lib/codex-remote/codex-home");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("applies non-secret defaults", async () => {
    const cwd = await createTemporaryDirectory();
    const loader = new ConfigLoader(
      {
        TELEGRAM_BOT_TOKEN: "123:test-token",
        TELEGRAM_ALLOWED_USER_IDS: "10",
      },
      cwd,
    );

    const config = loader.loadAppConfig();

    expect(config.projectsConfigPath).toBe(join(cwd, "projects.json"));
    expect(config.logLevel).toBe("info");
    expect(config.codexHome).toBeUndefined();
  });

  it("uses an environment snapshot taken at construction time", async () => {
    const cwd = await createTemporaryDirectory();
    const environment: NodeJS.ProcessEnv = {
      TELEGRAM_BOT_TOKEN: "123:original-token",
      TELEGRAM_ALLOWED_USER_IDS: "10",
    };
    const loader = new ConfigLoader(environment, cwd);

    environment.TELEGRAM_BOT_TOKEN = "456:changed-token";
    environment.TELEGRAM_ALLOWED_USER_IDS = "20";

    const config = loader.loadAppConfig();

    expect(config.telegramBotToken).toBe("123:original-token");
    expect([...config.telegramAllowedUserIds]).toEqual([10]);
  });

  it.each([
    [{ TELEGRAM_ALLOWED_USER_IDS: "1" }, "TELEGRAM_BOT_TOKEN"],
    [
      { TELEGRAM_BOT_TOKEN: "123:secret", TELEGRAM_ALLOWED_USER_IDS: "" },
      "TELEGRAM_ALLOWED_USER_IDS",
    ],
    [
      { TELEGRAM_BOT_TOKEN: "not-a-token", TELEGRAM_ALLOWED_USER_IDS: "1" },
      "TELEGRAM_BOT_TOKEN",
    ],
    [
      { TELEGRAM_BOT_TOKEN: "123:secret", TELEGRAM_ALLOWED_USER_IDS: "1,nope" },
      "TELEGRAM_ALLOWED_USER_IDS",
    ],
    [
      {
        TELEGRAM_BOT_TOKEN: "123:secret",
        TELEGRAM_ALLOWED_USER_IDS: "1",
        LOG_LEVEL: "verbose",
      },
      "LOG_LEVEL",
    ],
    [
      {
        TELEGRAM_BOT_TOKEN: "123:secret",
        TELEGRAM_ALLOWED_USER_IDS: "1",
        CODEX_HOME: "relative/auth",
      },
      "CODEX_HOME",
    ],
  ])("rejects invalid environment values safely", async (environment, variableName) => {
    const cwd = await createTemporaryDirectory();
    const loader = new ConfigLoader(environment, cwd);

    expect(() => loader.loadAppConfig()).toThrow(ConfigError);
    try {
      loader.loadAppConfig();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variableName).toBe(variableName);
      expect((error as Error).message).not.toContain("123:secret");
      expect((error as Error).message).not.toContain("relative/auth");
    }
  });

  it("loads a JSON projects document", async () => {
    const cwd = await createTemporaryDirectory();
    await writeFile(join(cwd, "projects.json"), '{"projects":{"demo":{}}}');
    const loader = new ConfigLoader(
      {
        TELEGRAM_BOT_TOKEN: "123:secret",
        TELEGRAM_ALLOWED_USER_IDS: "1",
      },
      cwd,
    );
    const config = loader.loadAppConfig();

    await expect(loader.loadProjectsDocument(config)).resolves.toEqual({
      projects: { demo: {} },
    });
  });

  it("reports unreadable and malformed project configuration without its path", async () => {
    const cwd = await createTemporaryDirectory();
    const loader = new ConfigLoader(
      {
        TELEGRAM_BOT_TOKEN: "123:secret",
        TELEGRAM_ALLOWED_USER_IDS: "1",
        PROJECTS_CONFIG: "private/projects.json",
      },
      cwd,
    );
    const config = loader.loadAppConfig();

    await expect(loader.loadProjectsDocument(config)).rejects.toMatchObject({
      code: "PROJECTS_CONFIG_UNREADABLE",
    });

    await writeFile(join(cwd, "broken.json"), "{not json");
    const malformedConfig = new ConfigLoader(
      {
        TELEGRAM_BOT_TOKEN: "123:secret",
        TELEGRAM_ALLOWED_USER_IDS: "1",
        PROJECTS_CONFIG: "broken.json",
      },
      cwd,
    ).loadAppConfig();

    await expect(loader.loadProjectsDocument(malformedConfig)).rejects.toMatchObject({
      code: "PROJECTS_CONFIG_INVALID_JSON",
    });
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-remote-config-test-"));
  temporaryDirectories.push(path);
  return path;
}

function snapshotEnvironment(names: readonly string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(snapshot: ReadonlyMap<string, string | undefined>): void {
  for (const [name, value] of snapshot) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
}
