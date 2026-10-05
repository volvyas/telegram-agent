import { describe, expect, it } from "vitest";

import {
  ProviderDiagnosticService,
  type ProviderDiagnosticProbeOptions,
} from "../../src/diagnostics/ProviderDiagnosticService.js";

const provider = {
  type: "responses" as const,
  name: "fake",
  baseUrl: "http://127.0.0.1:43123/v1",
  wireApi: "responses" as const,
};

describe("ProviderDiagnosticService", () => {
  it("validates discovery, Responses SSE, tool call, and full-history continuation", async () => {
    const requests: { url: string; body?: string; authorization?: string }[] = [];
    const result = await new ProviderDiagnosticService().probe({
      ...options(),
      apiKey: "secret-key",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
          ...(new Headers(init?.headers).get("Authorization") === null
            ? {}
            : { authorization: new Headers(init?.headers).get("Authorization") as string }),
        });
        if (String(input).endsWith("/models")) return new Response("{}", { status: 200 });
        const body = JSON.parse(String(init?.body)) as { input?: unknown };
        return new Response(Array.isArray(body.input) ? continuationSse() : functionCallSse(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    expect(result).toEqual({
      providerId: "fake",
      model: "fake-model",
      ok: true,
      checks: [
        { name: "discovery", code: "PASS", ok: true },
        { name: "responses_stream", code: "PASS", ok: true },
        { name: "tool_call", code: "PASS", ok: true },
        { name: "continuation", code: "PASS", ok: true },
      ],
    });
    expect(requests).toHaveLength(3);
    expect(requests[1]?.authorization).toBe("Bearer secret-key");
    expect(requests[2]?.body).toContain("function_call_output");
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("classifies authentication failure without exposing the response body", async () => {
    const result = await new ProviderDiagnosticService().probe({
      ...options(),
      fetch: async (input) => String(input).endsWith("/models")
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify({ error: "private credential details" }), { status: 401 }),
    });

    expect(result).toMatchObject({ ok: false, checks: [
      { name: "discovery", code: "PASS", ok: true },
      { name: "responses_stream", code: "AUTHENTICATION_FAILED", ok: false },
    ] });
    expect(JSON.stringify(result)).not.toContain("private credential details");
  });

  it("distinguishes malformed SSE, missing terminal events, and invalid tool calls", async () => {
    const malformed = await probeWithResponse(new Response("event: response.created\ndata: {bad\n\n", { status: 200 }));
    expect(malformed.checks.at(-1)).toMatchObject({ code: "MALFORMED_SSE", ok: false });

    const missingTerminal = await probeWithResponse(new Response("event: response.output_item.added\ndata: {}\n\n", { status: 200 }));
    expect(missingTerminal.checks.at(-1)).toMatchObject({ code: "MISSING_TERMINAL_EVENT", ok: false });

    const invalidTool = await probeWithResponse(new Response(invalidToolSse(), { status: 200 }));
    expect(invalidTool.checks.at(-1)).toMatchObject({ name: "tool_call", code: "INVALID_TOOL_CALL", ok: false });
  });

  it("classifies timeout and unknown model without blocking startup", async () => {
    const timeout = await new ProviderDiagnosticService().probe({
      ...options(),
      timeoutMs: 100,
      fetch: async () => { throw new DOMException("aborted", "AbortError"); },
    });
    expect(timeout).toMatchObject({ ok: false, checks: [{ code: "TIMEOUT", ok: false }] });

    const unknown = await new ProviderDiagnosticService().probe({
      ...options(),
      fetch: async (input) => String(input).endsWith("/models")
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify({ error: "unknown model secret-body" }), { status: 400 }),
    });
    expect(unknown.checks.at(-1)).toMatchObject({ code: "UNKNOWN_MODEL", ok: false });
    expect(JSON.stringify(unknown)).not.toContain("secret-body");
  });

  it("distinguishes TLS failure and Responses protocol mismatch", async () => {
    const unreachable = await new ProviderDiagnosticService().probe({
      ...options(),
      fetch: async () => { throw new Error("connect ECONNREFUSED"); },
    });
    expect(unreachable.checks).toEqual([{ name: "discovery", code: "NETWORK_UNREACHABLE", ok: false }]);

    const tls = await new ProviderDiagnosticService().probe({
      ...options(),
      fetch: async () => { throw new Error("self-signed certificate in certificate chain"); },
    });
    expect(tls.checks).toEqual([{ name: "discovery", code: "TLS_FAILED", ok: false }]);

    const mismatch = await new ProviderDiagnosticService().probe({
      ...options(),
      fetch: async (input) => String(input).endsWith("/models")
        ? new Response("{}", { status: 200 })
        : new Response("not responses", { status: 404 }),
    });
    expect(mismatch.checks.at(-1)).toMatchObject({ name: "responses_stream", code: "PROTOCOL_MISMATCH", ok: false });
  });
});

function options(): ProviderDiagnosticProbeOptions {
  return { providerId: "fake", provider, model: "fake-model" };
}

async function probeWithResponse(response: Response) {
  return new ProviderDiagnosticService().probe({
    ...options(),
    fetch: async (input) => String(input).endsWith("/models")
      ? new Response("{}", { status: 200 })
      : response,
  });
}

function functionCallSse(): string {
  return [
    event("response.output_item.added", { type: "response.output_item.added", item: { id: "fc-1", call_id: "call-1", name: "codex_remote_probe", type: "function_call", arguments: "" } }),
    event("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", delta: "{\"value\":" }),
    event("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", delta: "7}" }),
    event("response.output_item.done", { type: "response.output_item.done", item: { type: "function_call", arguments: "{\"value\":7}" } }),
    event("response.completed", { type: "response.completed" }),
  ].join("");
}

function invalidToolSse(): string {
  return [
    event("response.output_item.added", { type: "response.output_item.added", item: { id: "fc-1", call_id: "call-1", name: "wrong_tool", type: "function_call", arguments: "{\"value\":7}" } }),
    event("response.output_item.done", { type: "response.output_item.done", item: { type: "function_call", arguments: "{\"value\":7}" } }),
    event("response.completed", { type: "response.completed" }),
  ].join("");
}

function continuationSse(): string {
  return [
    event("response.output_text.delta", { type: "response.output_text.delta", delta: "PROBE_CONTINUED" }),
    event("response.completed", { type: "response.completed" }),
  ].join("");
}

function event(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
