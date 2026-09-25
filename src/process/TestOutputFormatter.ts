import { basename } from "node:path";

import type { ProcessResult } from "./ProcessRunner.js";

const MAX_RESULTS = 50;
const MAX_NAME_LENGTH = 180;
const MAX_DIAGNOSTIC_LENGTH = 200_000;

export interface FormattedTestOutput {
  readonly message: string;
  readonly diagnostic?: string;
}

interface TestLine {
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly count?: number;
}

export function formatTestOutput(
  result: ProcessResult,
  repositoryPath: string,
): FormattedTestOutput {
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const cleaned = sanitizeTestOutput(raw, repositoryPath);
  const parsed = parseTestLines(cleaned);
  const overall = overallStatus(result);
  const title = formatTitle(overall, result);
  const visible = parsed.slice(0, MAX_RESULTS);
  const omitted = parsed.length - visible.length;
  const lines = visible.map(formatTestLine);
  if (omitted > 0) lines.push(`… ${String(omitted)} more test suites`);
  const message = [title, ...lines].join("\n");
  const needsDiagnostic = cleaned.length > 0 && overall !== "passed";
  return Object.freeze({
    message,
    ...(needsDiagnostic
      ? { diagnostic: cleaned.slice(0, MAX_DIAGNOSTIC_LENGTH) }
      : {}),
  });
}

export function sanitizeTestOutput(value: string, repositoryPath: string): string {
  const withoutControls = stripTerminalControlSequences(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const withoutPath = repositoryPath.length === 0
    ? withoutControls
    : withoutControls.split(repositoryPath).join("[repository]");
  return redactAbsolutePaths(withoutPath)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.length > 0 || lines[index - 1]?.length !== 0)
    .join("\n")
    .trim();
}

function redactAbsolutePaths(value: string): string {
  return value
    .replace(/(^|[\s("'`])\/[^\s"'`()]+/gmu, "$1[local-path]")
    .replace(/\b[A-Za-z]:\\[^\s"'`()]+/gu, "[local-path]");
}

export function stripTerminalControlSequences(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const kind = value.charCodeAt(index + 1);
      if (kind === 0x5b) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current >= 0x40 && current <= 0x7e) break;
          index += 1;
        }
      } else if (kind === 0x5d) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current === 0x07) break;
          if (current === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
            index += 1;
            break;
          }
          index += 1;
        }
      } else {
        index += 1;
      }
      continue;
    }
    if (code === 0x9b) {
      while (index + 1 < value.length) {
        index += 1;
        const current = value.charCodeAt(index);
        if (current >= 0x40 && current <= 0x7e) break;
      }
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0x7f) continue;
    output += value[index];
  }
  return output;
}

function parseTestLines(content: string): readonly TestLine[] {
  const results: TestLine[] = [];
  for (const line of content.split("\n")) {
    const vitest = /^\s*([✓✗×↓❯])\s+(.+?)\s+\(\s*(\d+)\s+tests?(?:\s*\|\s*(\d+)\s+failed)?[^)]*\)/u.exec(line);
    if (vitest !== null) {
      const symbol = vitest[1] ?? "";
      const failed = Number(vitest[4] ?? "0") > 0 || symbol === "✗" || symbol === "×" || symbol === "❯";
      results.push({
        name: safeTestName(vitest[2] ?? "test"),
        status: symbol === "↓" ? "skipped" : failed ? "failed" : "passed",
        count: Number(vitest[3] ?? "0"),
      });
      continue;
    }

    const maven = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+).*?-- in (\S+)/u.exec(line);
    if (maven !== null) {
      const count = Number(maven[1] ?? "0");
      const failures = Number(maven[2] ?? "0") + Number(maven[3] ?? "0");
      const skipped = Number(maven[4] ?? "0");
      results.push({
        name: safeTestName(maven[5] ?? "test"),
        status: failures > 0 ? "failed" : skipped === count && count > 0 ? "skipped" : "passed",
        count,
      });
    }
  }
  return Object.freeze(results);
}

function safeTestName(value: string): string {
  const name = basename(value.replaceAll("\\", "/")).trim();
  return name.length <= MAX_NAME_LENGTH ? name : `${name.slice(0, MAX_NAME_LENGTH - 1)}…`;
}

function formatTestLine(line: TestLine): string {
  const icon = line.status === "passed" ? "✓" : line.status === "failed" ? "✗" : "–";
  const count = line.count === undefined
    ? ""
    : ` (${String(line.count)} ${line.count === 1 ? "test" : "tests"})`;
  return `${icon} ${line.name} — ${line.status}${count}`;
}

function overallStatus(result: ProcessResult): "passed" | "failed" | "stopped" | "timed out" {
  if (result.terminationReason === "aborted") return "stopped";
  if (result.terminationReason === "timed_out") return "timed out";
  return result.exitCode === 0 ? "passed" : "failed";
}

function formatTitle(
  status: ReturnType<typeof overallStatus>,
  result: ProcessResult,
): string {
  if (status === "failed" && result.exitCode !== null) {
    return `Tests: failed (exit code ${String(result.exitCode)})`;
  }
  return `Tests: ${status}`;
}
