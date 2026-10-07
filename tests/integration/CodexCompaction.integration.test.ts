import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { CodexAdapter } from "../../src/agent/codex/CodexAdapter.js";
import { ModelProviderResolver } from "../../src/agent/codex/ModelProviderResolver.js";
import { ModelProviderSecrets } from "../../src/config/ConfigLoader.js";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";

function reply(response: ServerResponse, text: string, tokens: number): void {
  const item = { id: "msg_fake", type: "message", role: "assistant", content: [{ type: "output_text", text }] };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: "resp_fake", status: "in_progress" } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id: "resp_fake", status: "completed", output: [item],
      usage: { input_tokens: tokens, output_tokens: 10, total_tokens: tokens + 10,
        input_tokens_details: { cached_tokens: tokens - 10 } } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

it.each(["success", "failure", "below-threshold", "mid-turn", "cancel"])("uses the installed SDK context budget: %s", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "codex-compaction-"));
  const requests: { path: string | undefined; body: Record<string, unknown> }[] = [];
  let compactArrived: (() => void) | undefined;
  const compactPending = new Promise<void>((resolve) => { compactArrived = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    requests.push({ path: request.url, body });
    if (mode === "cancel" && requests.length === 2) { compactArrived?.(); return; }
    if (requests.length > 5) { response.writeHead(400).end(); return; }
    if (mode === "failure" && requests.length >= 2) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Compaction unsupported", type: "invalid_request_error" } }));
      return;
    }
    if (mode === "mid-turn" && requests.length === 1) {
      const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "exec_command", arguments: JSON.stringify({ cmd: "printf TOOL_DONE", max_output_tokens: 20 }) };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { id: "resp_tool", status: "completed", output: [item], usage: { input_tokens: 27000, output_tokens: 10, total_tokens: 27010 } } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
      return;
    }
    reply(response, requests.length === 1 ? "FIRST" : "COMPACTED_SUMMARY KEEP_BLUE TOOL_DONE", requests.length === 1 && mode !== "below-threshold" ? 27000 : 100);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  try {
    const repo = join(root, "repo");
    const home = join(root, "codex-home");
    await mkdir(repo); await mkdir(home);
    await promisify(execFile)("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const provider = new ModelProviderResolver(new Map([["local", {
      type: "responses", name: "mock", wireApi: "responses", baseUrl: `http://127.0.0.1:${address.port}/v1`,
    }]]), new ModelProviderSecrets(new Map())).resolve({
      id: "test", name: "Test", path: repo, allowedOperations: new Set(["task"]),
      agent: { provider: "local", model: "mock-model", context: {
        windowTokens: 32768, outputReserveTokens: 4096, safetyMarginTokens: 2048,
      } },
    });
    const createAdapter = () => new CodexAdapter({ provider, codexHome: home,
      environment: { HOME: root, PATH: process.env.PATH, LANG: "C.UTF-8" } });
    const firstAdapter = createAdapter();
    const first = await collect((await firstAdapter.start({ projectId: "test", workingDirectory: repo, prompt: "Keep constraint KEEP_BLUE. Return FIRST." })).events);
    expect(first.some((event) => event.type === "completed")).toBe(true);
    if (mode === "mid-turn") {
      expect(requests).toHaveLength(3);
      const compactInput = requests[1]?.body.input as Record<string, unknown>[];
      expect(compactInput.some((item) => item.type === "function_call" && item.call_id === "call_fixture")).toBe(true);
      expect(compactInput.some((item) => item.type === "function_call_output" && item.call_id === "call_fixture")).toBe(true);
      expect(first.some((event) => event.type === "command" && event.status === "completed" && event.exitCode === 0)).toBe(true);
      expect(JSON.stringify(requests[2]?.body.input)).toContain("COMPACTED_SUMMARY KEEP_BLUE TOOL_DONE");
      return;
    }
    const threadId = firstAdapter.getThreadId("test");
    expect(threadId).toBeDefined();
    const secondAdapter = createAdapter();
    const secondRun = await secondAdapter.send({ projectId: "test", workingDirectory: repo,
      threadId: threadId as string, message: "Continue with KEEP_BLUE." });
    const collecting = collect(secondRun.events);
    if (mode === "cancel") {
      await compactPending;
      expect(await secondAdapter.stop(secondRun.runId)).toBe(true);
      const stopped = await collecting;
      expect(stopped.at(-1)).toMatchObject({ type: "stopped", reason: "user" });
      expect(stopped.some((event) => event.type === "completed")).toBe(false);
      expect(requests).toHaveLength(2);
      return;
    }
    const second = await collecting;
    if (mode === "failure") {
      expect(requests.length).toBeLessThanOrEqual(7);
      expect(second.some((event) => event.type === "completed")).toBe(false);
      expect(second.some((event) => event.type === "error" && event.fatal)).toBe(true);
      // No ordinary generation after failed compaction, even with native retries.
      expect(requests.slice(1).every((request) => (request.body.tools as unknown[]).length === 0)).toBe(true);
      return;
    }
    if (mode === "below-threshold") {
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1]?.body.input)).toContain("FIRST");
      expect(second.some((event) => event.type === "completed")).toBe(true);
      return;
    }
    expect(requests.map((r) => ({ path: r.path, tools: Array.isArray(r.body.tools) ? r.body.tools.length : 0 }))).toEqual([
      { path: "/v1/responses", tools: expect.any(Number) },
      { path: "/v1/responses", tools: 0 },
      { path: "/v1/responses", tools: expect.any(Number) },
    ]);
    expect(JSON.stringify(requests[1]?.body.input)).toContain("KEEP_BLUE");
    expect(JSON.stringify(requests[2]?.body.input)).toContain("COMPACTED_SUMMARY");
    expect(second.some((event) => event.type === "completed")).toBe(true);
    const third = await collect((await createAdapter().send({ projectId: "test", workingDirectory: repo,
      threadId: threadId as string, message: "Continue after restart." })).events);
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[3]?.body.input)).toContain("COMPACTED_SUMMARY KEEP_BLUE TOOL_DONE");
    expect(third.some((event) => event.type === "completed")).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
