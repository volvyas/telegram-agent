import type { ResponsesProviderConfig } from "../config/ProjectConfig.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SSE_BYTES = 256 * 1024;
const PROBE_TOOL_NAME = "codex_remote_probe";
const PROBE_VALUE = 7;

export type ProviderDiagnosticCode =
  | "PASS"
  | "NETWORK_UNREACHABLE"
  | "TIMEOUT"
  | "TLS_FAILED"
  | "AUTHENTICATION_FAILED"
  | "UNKNOWN_MODEL"
  | "PROTOCOL_MISMATCH"
  | "MALFORMED_SSE"
  | "MISSING_TERMINAL_EVENT"
  | "INVALID_TOOL_CALL"
  | "PROVIDER_ERROR";

export interface ProviderDiagnosticCheck {
  readonly name: "discovery" | "responses_stream" | "tool_call" | "continuation";
  readonly code: ProviderDiagnosticCode;
  readonly ok: boolean;
}

export interface ProviderDiagnosticResult {
  readonly providerId: string;
  readonly model: string;
  readonly ok: boolean;
  readonly checks: readonly ProviderDiagnosticCheck[];
}

export interface ProviderDiagnosticProbeOptions {
  readonly providerId: string;
  readonly provider: ResponsesProviderConfig;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
}

interface StreamResult {
  readonly completed: boolean;
  readonly malformed: boolean;
  readonly functionCall?: {
    readonly id: string;
    readonly callId: string;
    readonly name: string;
    readonly arguments: string;
  };
  readonly text: string;
}

export class ProviderDiagnosticService {
  public async probe(options: ProviderDiagnosticProbeOptions): Promise<ProviderDiagnosticResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new TypeError("timeoutMs must be between 100 and 120000");
    }

    const checks: ProviderDiagnosticCheck[] = [];
    const fetcher = options.fetch ?? globalThis.fetch;
    const headers = requestHeaders(options.apiKey);

    const discovery = await this.#discover(fetcher, options.provider.baseUrl, headers, timeoutMs, options.signal);
    checks.push({ name: "discovery", code: discovery.code, ok: discovery.ok });
    if (!discovery.ok) {
      return result(options, checks);
    }

    const first = await this.#responsesTurn(
      fetcher,
      options.provider.baseUrl,
      headers,
      toolRequestBody(options.model),
      timeoutMs,
      options.signal,
    );
    checks.push({
      name: "responses_stream",
      code: first.code,
      ok: first.ok,
    });
    if (!first.ok || first.stream === undefined) return result(options, checks);

    const call = first.stream.functionCall;
    const callArguments = call === undefined ? undefined : parseJsonRecord(call.arguments);
    const toolOk = call !== undefined &&
      call.name === PROBE_TOOL_NAME &&
      callArguments?.value === PROBE_VALUE;
    checks.push({
      name: "tool_call",
      code: toolOk ? "PASS" : "INVALID_TOOL_CALL",
      ok: toolOk,
    });
    if (!toolOk || call === undefined) return result(options, checks);

    const continuation = await this.#responsesTurn(
      fetcher,
      options.provider.baseUrl,
      headers,
      continuationBody(options.model, call),
      timeoutMs,
      options.signal,
    );
    const continuationOk = continuation.ok &&
      continuation.stream?.text.includes("PROBE_CONTINUED") === true;
    checks.push({
      name: "continuation",
      code: continuationOk ? "PASS" : continuation.code,
      ok: continuationOk,
    });
    return result(options, checks);
  }

  async #discover(
    fetcher: typeof globalThis.fetch,
    baseUrl: string,
    headers: Record<string, string>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly ok: boolean; readonly code: ProviderDiagnosticCode }> {
    try {
      const response = await fetchWithTimeout(fetcher, `${baseUrl}/models`, {
        method: "GET",
        headers,
        ...(signal === undefined ? {} : { signal }),
      }, timeoutMs);
      if (response.status === 401 || response.status === 403) return { ok: false, code: "AUTHENTICATION_FAILED" };
      if (response.status >= 500) return { ok: false, code: "PROVIDER_ERROR" };
      return { ok: true, code: "PASS" };
    } catch (error) {
      return { ok: false, code: classifyNetworkError(error) };
    }
  }

  async #responsesTurn(
    fetcher: typeof globalThis.fetch,
    baseUrl: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{
    readonly ok: boolean;
    readonly code: ProviderDiagnosticCode;
    readonly stream?: StreamResult;
  }> {
    let response: Response;
    try {
      response = await fetchWithTimeout(fetcher, `${baseUrl}/responses`, {
        method: "POST",
        headers: { ...headers, Accept: "text/event-stream" },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      }, timeoutMs);
    } catch (error) {
      return { ok: false, code: classifyNetworkError(error) };
    }

    if (response.status === 401 || response.status === 403) return { ok: false, code: "AUTHENTICATION_FAILED" };
    if (response.status === 404) return { ok: false, code: "PROTOCOL_MISMATCH" };
    if (response.status === 400) {
      const bodyText = await boundedBody(response);
      return { ok: false, code: /model|unknown/i.test(bodyText) ? "UNKNOWN_MODEL" : "PROTOCOL_MISMATCH" };
    }
    if (!response.ok) return { ok: false, code: response.status >= 500 ? "PROVIDER_ERROR" : "PROTOCOL_MISMATCH" };
    if (!response.body) return { ok: false, code: "MALFORMED_SSE" };

    const stream = await readSse(response.body);
    if (stream.malformed) return { ok: false, code: "MALFORMED_SSE", stream };
    if (!stream.completed) return { ok: false, code: "MISSING_TERMINAL_EVENT", stream };
    return { ok: true, code: "PASS", stream };
  }
}

function result(
  options: ProviderDiagnosticProbeOptions,
  checks: readonly ProviderDiagnosticCheck[],
): ProviderDiagnosticResult {
  return Object.freeze({
    providerId: options.providerId,
    model: options.model,
    ok: checks.every((check) => check.ok),
    checks: Object.freeze([...checks]),
  });
}

function requestHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey === undefined
    ? { "Content-Type": "application/json" }
    : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

function toolRequestBody(model: string): Record<string, unknown> {
  return {
    model,
    input: "Call the diagnostic tool exactly once with value 7. Do not output text.",
    stream: true,
    max_output_tokens: 64,
    enable_thinking: false,
    tool_choice: "required",
    tools: [{
      type: "function",
      name: PROBE_TOOL_NAME,
      description: "Record a harmless diagnostic value; no side effects.",
      parameters: {
        type: "object",
        properties: { value: { type: "integer" } },
        required: ["value"],
        additionalProperties: false,
      },
    }],
  };
}

function continuationBody(
  model: string,
  call: NonNullable<StreamResult["functionCall"]>,
): Record<string, unknown> {
  return {
    model,
    input: [
      { role: "user", content: "Call the diagnostic tool exactly once with value 7." },
      { type: "function_call", id: call.id, call_id: call.callId, name: call.name, arguments: call.arguments },
      { type: "function_call_output", call_id: call.callId, output: JSON.stringify({ ok: true, value: PROBE_VALUE }) },
      { role: "user", content: "The tool ran successfully. Reply with exactly PROBE_CONTINUED." },
    ],
    stream: true,
    max_output_tokens: 64,
    enable_thinking: false,
  };
}

async function fetchWithTimeout(
  fetcher: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

async function boundedBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 4_096);
  } catch {
    return "";
  }
}

async function readSse(body: ReadableStream<Uint8Array>): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  let event = "";
  let data = "";
  let completed = false;
  let malformed = false;
  let text = "";
  let functionCall: { id: string; callId: string; name: string; arguments: string } | undefined;

  const consume = (line: string): void => {
    if (line.startsWith("event: ")) {
      event = line.slice(7);
    } else if (line.startsWith("data: ")) {
      data += line.slice(6);
    } else if (line === "") {
      if (data.length > 0) {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const responseEvent = parsed.type;
          if (responseEvent === "response.completed") completed = true;
          if (responseEvent === "response.output_text.delta" && typeof parsed.delta === "string") text += parsed.delta;
          if (responseEvent === "response.output_item.added" && isRecord(parsed.item) && parsed.item.type === "function_call") {
            functionCall = {
              id: stringValue(parsed.item.id),
              callId: stringValue(parsed.item.call_id),
              name: stringValue(parsed.item.name),
              arguments: stringValue(parsed.item.arguments),
            };
          }
          if (responseEvent === "response.function_call_arguments.delta" && typeof parsed.delta === "string" && functionCall !== undefined) {
            functionCall.arguments += parsed.delta;
          }
          if (event === "response.output_item.done" && isRecord(parsed.item) && parsed.item.type === "function_call" && functionCall !== undefined) {
            functionCall.arguments = stringValue(parsed.item.arguments);
          }
        } catch {
          malformed = true;
        }
      }
      event = "";
      data = "";
    }
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_SSE_BYTES) return { completed: false, malformed: true, text };
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line.replace(/\r$/u, ""));
    if (malformed) return { completed, malformed: true, text, ...(functionCall === undefined ? {} : { functionCall }) };
  }
  if (buffer.length > 0) consume(buffer);
  return { completed, malformed, text, ...(functionCall === undefined ? {} : { functionCall }) };
}

function classifyNetworkError(error: unknown): ProviderDiagnosticCode {
  if (error instanceof DOMException && error.name === "AbortError") return "TIMEOUT";
  if (error instanceof Error && error.name === "AbortError") return "TIMEOUT";
  if (error instanceof Error && /tls|certificate|cert|self.?signed|unable to verify/i.test(`${error.name} ${error.message}`)) {
    return "TLS_FAILED";
  }
  return "NETWORK_UNREACHABLE";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
