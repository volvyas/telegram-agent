import { describe, expect, it } from "vitest";

import { StructuredLogger } from "../../src/logging/StructuredLogger.js";

describe("StructuredLogger", () => {
  it("writes JSON lines and redacts secrets and sensitive paths", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({
      level: "debug",
      secrets: ["123:bot-token", "/private/codex-home"],
      clock: () => new Date("2026-09-23T12:00:00.000Z"),
      sink: (line) => lines.push(line),
    });

    logger.info("request failed for 123:bot-token", {
      token: "123:bot-token",
      projectPath: "/private/repository",
      nested: { codexHome: "/private/codex-home", safe: "value" },
    });

    expect(JSON.parse(lines[0] ?? "")).toEqual({
      timestamp: "2026-09-23T12:00:00.000Z",
      level: "info",
      message: "request failed for [REDACTED]",
      fields: {
        token: "[REDACTED]",
        projectPath: "[PATH_REDACTED]",
        nested: { codexHome: "[REDACTED]", safe: "value" },
      },
    });
    expect(lines.join("\n")).not.toContain("123:bot-token");
    expect(lines.join("\n")).not.toContain("/private/codex-home");
  });

  it("filters entries below the configured level", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ level: "warn", sink: (line) => lines.push(line) });
    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(["warn", "error"]);
  });

  it("redacts a configured issue tracker token in messages and nested fields", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({
      secrets: ["github-read-token"],
      sink: (line) => lines.push(line),
    });

    logger.error("GitHub request failed: github-read-token", {
      response: { detail: "Bearer github-read-token" },
    });

    expect(lines.join("\n")).not.toContain("github-read-token");
    expect(lines.join("\n")).toContain("[REDACTED]");
  });
});
