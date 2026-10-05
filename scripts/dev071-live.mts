import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import type { AgentEvent } from "../src/agent/AgentEvent.js";
import { CodexAdapter } from "../src/agent/codex/CodexAdapter.js";

interface RunEvidence {
  readonly durationMs: number;
  readonly firstSdkEventMs?: number;
  readonly threadId?: string;
  readonly types: readonly string[];
  readonly commandCompletions: number;
  readonly commandFailures: number;
  readonly recoverableErrors: number;
  readonly fatalErrors: number;
  readonly expectedMarkerSeen: boolean;
  readonly terminal?: string;
}

const execFileAsync = promisify(execFile);

const repo = required("DEV071_REPO");
const codexHome = required("DEV071_CODEX_HOME");
const providerId = required("DEV071_PROVIDER_ID");
const baseUrl = validatedBaseUrl(required("DEV071_BASE_URL"));
const model = required("DEV071_MODEL");
if (required("DEV071_CONFIRM_DISPOSABLE") !== "1") {
  throw new Error("DEV071_CONFIRM_DISPOSABLE must equal 1");
}
await validateDisposableRepository();
const provider = Object.freeze({
  providerId,
  model,
  config: Object.freeze({
    model_provider: providerId,
    model_providers: Object.freeze({
      [providerId]: Object.freeze({
        name: "DEV-071 live acceptance",
        base_url: baseUrl,
        wire_api: "responses",
      }),
    }),
  }),
});

const protocolTiming = await measureResponsesTiming();

const createAdapter = (): CodexAdapter => new CodexAdapter({
  provider,
  codexHome,
  environment: process.env,
  protectedPaths: [`${repo}/.git/config`],
});

const firstAdapter = createAdapter();
const first = await firstAdapter.start({
  projectId: "dev071",
  workingDirectory: repo,
  prompt: "Acceptance test in this disposable repository only. Run pwd. Create acceptance.txt containing exactly DEV-071 followed by a newline. Run git status --short -- acceptance.txt. Finish with the marker ACCEPTANCE_DONE. Do not access paths outside the working directory.",
});
const firstResult = await collect(first, "ACCEPTANCE_DONE");
if (firstResult.threadId === undefined) throw new Error("first turn did not start a thread");
assertCompleted("first turn", firstResult);
if ((await readFile(`${repo}/acceptance.txt`, "utf8")) !== "DEV-071\n") {
  throw new Error("first turn did not create the exact acceptance fixture");
}

// A fresh adapter with the same CODEX_HOME simulates a gateway process restart.
const restartedAdapter = createAdapter();
const second = await restartedAdapter.send({
  projectId: "dev071",
  workingDirectory: repo,
  threadId: firstResult.threadId,
  message: "Read acceptance.txt. If it contains exactly DEV-071, finish with the marker CONTEXT_OK. Do not modify files.",
});
const secondResult = await collect(second, "CONTEXT_OK");
assertCompleted("post-restart turn", secondResult);
if (secondResult.threadId !== firstResult.threadId) {
  throw new Error("post-restart turn did not preserve the thread identity");
}

const stopRun = await restartedAdapter.start({
  projectId: "dev071-stop",
  workingDirectory: repo,
  prompt: "Wait and reason silently until asked to stop. Do not run commands and do not modify files.",
});
if (!(await restartedAdapter.stop(stopRun.runId))) {
  throw new Error("live cancellation did not find its active run");
}
const stopResult = await collect(stopRun, "");
if (stopResult.terminal !== "stopped" || stopResult.fatalErrors !== 0) {
  throw new Error("live cancellation did not end in the stopped state");
}

console.log(JSON.stringify({
  providerId,
  model,
  baseUrl,
  checks: {
    protocolTiming,
    firstTurn: publicEvidence(firstResult),
    postRestartResume: publicEvidence(secondResult),
    stop: publicEvidence(stopResult),
    fixtureExact: true,
    sameThreadAfterRestart: true,
  },
}, null, 2));

async function collect(
  run: Awaited<ReturnType<CodexAdapter["start"]>>,
  expectedMarker: string,
): Promise<RunEvidence> {
  const started = Date.now();
  let firstSdkEventMs: number | undefined;
  let threadId: string | undefined;
  let commandCompletions = 0;
  let commandFailures = 0;
  let recoverableErrors = 0;
  let fatalErrors = 0;
  let expectedMarkerSeen = expectedMarker.length === 0;
  let terminal: string | undefined;
  const types: string[] = [];

  for await (const event of run.events) {
    firstSdkEventMs ??= Date.now() - started;
    types.push(event.type);
    if (event.type === "thread_started") threadId = event.threadId;
    if (event.type === "command" && event.status === "completed") commandCompletions += 1;
    if (event.type === "command" && event.status === "failed") commandFailures += 1;
    if (event.type === "error") {
      if (event.fatal) fatalErrors += 1;
      else recoverableErrors += 1;
    }
    if (event.type === "progress" && event.message.includes(expectedMarker)) {
      expectedMarkerSeen = true;
    }
    if (isTerminal(event)) terminal = event.type;
  }

  return {
    durationMs: Date.now() - started,
    ...(firstSdkEventMs === undefined ? {} : { firstSdkEventMs }),
    ...(threadId === undefined ? {} : { threadId }),
    types,
    commandCompletions,
    commandFailures,
    recoverableErrors,
    fatalErrors,
    expectedMarkerSeen,
    ...(terminal === undefined ? {} : { terminal }),
  };
}

async function measureResponsesTiming(): Promise<{
  readonly firstOutputMs: number;
  readonly durationMs: number;
}> {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "Reply with exactly TIMING_OK.", stream: true }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`timing probe failed with HTTP ${String(response.status)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let firstOutputMs: number | undefined;
  let completed = false;
  let bytes = 0;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 1_048_576) throw new Error("timing probe exceeded its response limit");
    pending += decoder.decode(chunk.value, { stream: true });
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const event = JSON.parse(line.slice(6)) as { readonly type?: unknown };
      if (event.type === "response.output_text.delta") {
        firstOutputMs ??= Date.now() - started;
      }
      if (event.type === "response.completed") completed = true;
    }
  }
  if (!completed || firstOutputMs === undefined) {
    throw new Error("timing probe ended without output and terminal completion");
  }
  return { firstOutputMs, durationMs: Date.now() - started };
}

async function validateDisposableRepository(): Promise<void> {
  const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo });
  if (status.stdout.length !== 0) {
    throw new Error("DEV071_REPO must be a clean disposable Git repository");
  }
  let fixtureExists = false;
  try {
    await lstat(`${repo}/acceptance.txt`);
    fixtureExists = true;
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
  if (fixtureExists) throw new Error("disposable repository already contains acceptance.txt");
}

function publicEvidence(result: RunEvidence): Omit<RunEvidence, "threadId"> {
  const { threadId: _threadId, ...evidence } = result;
  return evidence;
}

function assertCompleted(label: string, result: RunEvidence): void {
  if (result.terminal !== "completed" || result.fatalErrors !== 0) {
    throw new Error(`${label} did not complete successfully`);
  }
  if (!result.expectedMarkerSeen) throw new Error(`${label} omitted its completion marker`);
  if (result.commandFailures !== 0) throw new Error(`${label} contained a failed command`);
}

function isTerminal(event: AgentEvent): boolean {
  return event.type === "completed" || event.type === "stopped" ||
    event.type === "question" || event.type === "issue_proposal" ||
    (event.type === "error" && event.fatal);
}

function validatedBaseUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 || url.password.length > 0 ||
      url.search.length > 0 || url.hash.length > 0) {
    throw new Error("DEV071_BASE_URL must be an absolute HTTP(S) URL without credentials, query or fragment");
  }
  return value.replace(/\/+$/u, "");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
