import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { CodexAdapter } from "../../src/agent/codex/CodexAdapter.js";
import { CodexClientFactory } from "../../src/agent/codex/CodexClientFactory.js";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";

const temporaryDirectories: string[] = [];
const servers: FakeResponsesServer[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("real Codex SDK boundary", () => {
  it("runs a new streamed turn and resumes it through a deterministic fake Responses server", async () => {
    const server = await fakeServer();
    const root = await temporaryDirectory();
    const repository = join(root, "repo");
    await mkdir(repository);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome);
    const adapter = new CodexAdapter({
      clientFactory: new CodexClientFactory(),
      codexHome,
      environment: {
        HOME: root,
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        CODEX_API_KEY: "provider-secret",
      },
      provider: {
        providerId: "fake-responses",
        model: "fake-model",
        config: {
          model_provider: "fake-responses",
          model_providers: {
            "fake-responses": {
              name: "deterministic fake",
              base_url: `${server.baseUrl}/v1`,
              wire_api: "responses",
            },
          },
        },
      },
      protectedPaths: [join(repository, ".git", "config")],
      idFactory: () => "RUN-REAL-1",
    });

    const first = await adapter.start({
      projectId: "demo",
      workingDirectory: repository,
      prompt: "Return exactly FAKE_FIRST.",
    });
    const firstEvents = await collect(first.events);
    const threadId = adapter.getThreadId("demo");

    expect(firstEvents.filter(isMeaningfulEvent)).toEqual([
      expect.objectContaining({ type: "thread_started" }),
      expect.objectContaining({ type: "run_started" }),
      expect.objectContaining({ type: "progress", message: "FAKE_FIRST" }),
      expect.objectContaining({ type: "completed", summary: "FAKE_FIRST" }),
    ]);
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/u);

    const resumed = await adapter.send({
      projectId: "demo",
      workingDirectory: repository,
      threadId: threadId as string,
      message: "Continue and return exactly FAKE_SECOND.",
    });
    const resumedEvents = await collect(resumed.events);

    expect(resumedEvents.filter(isMeaningfulEvent)).toEqual([
      expect.objectContaining({ type: "thread_started", threadId: threadId as string }),
      expect.objectContaining({ type: "run_started" }),
      expect.objectContaining({ type: "progress", message: "FAKE_SECOND" }),
      expect.objectContaining({ type: "completed", summary: "FAKE_SECOND" }),
    ]);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.body.model).toBe("fake-model");
    expect(server.requests[1]?.body.model).toBe("fake-model");
    expect(Array.isArray(server.requests[0]?.body.tools)).toBe(true);
    expect(server.requests[0]?.authorizationPresent).toBe(false);
    expect(JSON.stringify(server.requests)).not.toContain("provider-secret");
    await expect(execFileAsync("git", ["status", "--porcelain"], { cwd: repository })).resolves.toMatchObject({ stdout: "" });
  }, 30_000);
});

class FakeResponsesServer {
  readonly #server: Server;
  readonly requests: { readonly body: Record<string, unknown>; readonly authorizationPresent: boolean }[] = [];
  readonly baseUrl: string;

  private constructor(server: Server, port: number) {
    this.#server = server;
    this.baseUrl = `http://127.0.0.1:${String(port)}`;
  }

  static async start(): Promise<FakeResponsesServer> {
    const server = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        thisRequest(server, { body, authorizationPresent: request.headers.authorization !== undefined });
        const prompt = JSON.stringify(body.input ?? body.prompt ?? "");
        const text = prompt.includes("FAKE_SECOND") ? "FAKE_SECOND" : "FAKE_FIRST";
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        response.write(sse("response.created", { type: "response.created", response: { id: "fake-response", status: "in_progress" } }));
        response.write(sse("response.output_item.added", { type: "response.output_item.added", item: { id: "fake-message", type: "message", role: "assistant", content: [] } }));
        response.write(sse("response.output_text.delta", { type: "response.output_text.delta", delta: text }));
        response.write(sse("response.output_text.done", { type: "response.output_text.done", text }));
        response.write(sse("response.output_item.done", { type: "response.output_item.done", item: { id: "fake-message", type: "message", role: "assistant", content: [{ type: "output_text", text }] } }));
        response.end(sse("response.completed", { type: "response.completed", response: { id: "fake-response", status: "completed", output: [] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fake server did not bind");
    const instance = new FakeResponsesServer(server, address.port);
    activeRequests.set(server, instance);
    return instance;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.#server.close((error) => error === undefined ? resolve() : reject(error)));
  }
}

const activeRequests = new WeakMap<Server, FakeResponsesServer>();

function thisRequest(server: Server, request: { readonly body: Record<string, unknown>; readonly authorizationPresent: boolean }): void {
  activeRequests.get(server)?.requests.push(request);
}

async function fakeServer(): Promise<FakeResponsesServer> {
  const server = await FakeResponsesServer.start();
  servers.push(server);
  return server;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-remote-integration-"));
  temporaryDirectories.push(path);
  return path;
}

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function isMeaningfulEvent(event: AgentEvent): boolean {
  return event.type !== "warning" && !(event.type === "error" && !event.fatal);
}
