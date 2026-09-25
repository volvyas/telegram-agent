import { describe, expect, it } from "vitest";

import type { ProcessResult } from "../../src/process/ProcessRunner.js";
import {
  formatTestOutput,
  sanitizeTestOutput,
  stripTerminalControlSequences,
} from "../../src/process/TestOutputFormatter.js";

describe("TestOutputFormatter", () => {
  it("turns colored Vitest output into suite names and results", () => {
    const output = [
      "\u001B[1m\u001B[46m RUN \u001B[49m\u001B[22m v4.1.11 /private/repository",
      "\u001B[32m✓\u001B[39m tests/confirmations/ConfirmationService.test.ts \u001B[2m(\u001B[22m 3 tests \u001B[2m)\u001B[22m",
      "\u001B[31m❯\u001B[39m tests/telegram/Помилка.test.ts (2 tests | 1 failed)",
      "\u001B[33m↓\u001B[39m tests/Skipped.test.ts (1 test)",
    ].join("\n");

    const formatted = formatTestOutput(result(1, output), "/private/repository");

    expect(formatted.message).toBe([
      "Tests: failed (exit code 1)",
      "✓ ConfirmationService.test.ts — passed (3 tests)",
      "✗ Помилка.test.ts — failed (2 tests)",
      "– Skipped.test.ts — skipped (1 test)",
    ].join("\n"));
    expect(formatted.message).not.toContain("\u001B");
    expect(formatted.message).not.toContain("/private/repository");
    expect(formatted.diagnostic).toContain("[repository]");
  });

  it("formats Maven suite summaries", () => {
    const output = [
      "[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1 s -- in ua.demo.МоторTest",
      "[INFO] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 1 s -- in ua.demo.FailedTest",
    ].join("\n");

    expect(formatTestOutput(result(1, output), "/repo").message).toBe([
      "Tests: failed (exit code 1)",
      "✓ ua.demo.МоторTest — passed (4 tests)",
      "✗ ua.demo.FailedTest — failed (2 tests)",
    ].join("\n"));
  });

  it("keeps successful unrecognized output out of Telegram", () => {
    expect(formatTestOutput(result(0, "arbitrary success noise"), "/repo")).toEqual({
      message: "Tests: passed",
    });
  });

  it("sanitizes paths, OSC, CSI and control characters in failure diagnostics", () => {
    const dirty = "\u001B]0;secret title\u0007/private/repo/file.ts\u001B[31m failed\u001B[0m at /home/user/tool.js C:\\temp\\test.js\u0000";
    expect(stripTerminalControlSequences(dirty)).toBe(
      "/private/repo/file.ts failed at /home/user/tool.js C:\\temp\\test.js",
    );
    const sanitized = sanitizeTestOutput(dirty, "/private/repo");
    expect(sanitized).toBe("[repository]/file.ts failed at [local-path] [local-path]");
    expect(sanitized).not.toContain("/home/user");
  });

  it("bounds the number of visible suites", () => {
    const output = Array.from(
      { length: 55 },
      (_, index) => `✓ tests/Suite${String(index)}.test.ts (1 test)`,
    ).join("\n");
    const message = formatTestOutput(result(0, output), "/repo").message;
    expect(message).toContain("… 5 more test suites");
    expect(message).not.toContain("Suite54.test.ts");
  });
});

function result(exitCode: number, stdout: string): ProcessResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 10,
  };
}
