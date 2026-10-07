import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest, createServer, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ProviderLoggingProxyOptions {
  readonly upstream: string;
  readonly directory: string;
  readonly captureBodies?: boolean;
  readonly maxBodyBytes?: number;
  readonly maxRequests?: number;
  readonly timeoutMs?: number;
  readonly onLogError?: () => void;
}

// Capture the original bytes, never parse/re-serialize provider payloads.
class Capture extends Transform {
  readonly hash = createHash("sha256");
  readonly chunks: Buffer[] = [];
  bytes = 0;
  capturedBytes = 0;

  constructor(readonly limit: number) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    const remaining = this.limit - this.capturedBytes;
    if (remaining > 0) {
      const captured = Buffer.from(chunk.subarray(0, remaining));
      this.chunks.push(captured);
      this.capturedBytes += captured.length;
    }
    callback(null, chunk);
  }

  summary() {
    return { bytes: this.bytes, capturedBytes: this.capturedBytes,
      truncated: this.bytes > this.capturedBytes, sha256: this.hash.digest("hex") };
  }
}

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const connectionHeaders = (headers.connection ?? "").split(",").map((value) => value.trim().toLowerCase());
  for (const name of ["host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", ...connectionHeaders]) delete result[name];
  return result;
}

export async function createProviderLoggingProxy(options: ProviderLoggingProxyOptions) {
  const upstream = new URL(options.upstream);
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password ||
    upstream.search || upstream.hash) throw new Error("Invalid upstream HTTP(S) base URL");
  const maxBodyBytes = options.maxBodyBytes ?? 2 * 1024 * 1024;
  const maxRequests = options.maxRequests ?? 100;
  const timeoutMs = options.timeoutMs ?? 300_000;
  for (const value of [maxBodyBytes, maxRequests, timeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Limits must be positive integers");
  }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(options.directory, "provider-trace-"));
  const pending = new Set<Promise<void>>();
  let accepted = 0;
  const server = createServer((request, response) => {
    const route = request.url;
    if (!((request.method === "GET" && route === "/v1/models") ||
      (request.method === "POST" && (route === "/v1/responses" || route === "/v1/responses/compact")))) {
      response.writeHead(404).end(); request.resume(); return;
    }
    // Stop accepting requests at the session quota; never silently lose evidence.
    if (accepted >= maxRequests) { response.writeHead(503).end("Trace request limit reached"); request.resume(); return; }
    accepted++;
    const job = handle();
    pending.add(job);
    void job.finally(() => pending.delete(job));

    async function handle(): Promise<void> {
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      const start = Date.now();
      const captureLimit = options.captureBodies === true ? maxBodyBytes : 0;
      const input = new Capture(captureLimit);
      const output = new Capture(captureLimit);
      let status: number | undefined;
      let outcome = "complete";
      const target = new URL(upstream);
      target.pathname = `${upstream.pathname.replace(/\/+$/u, "")}${route?.slice(3)}`;
      const outgoing = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
        method: request.method, headers: forwardHeaders(request.headers),
      });
      const abort = () => outgoing.destroy(new Error("Client disconnected"));
      response.on("close", abort);
      const deadline = setTimeout(() => outgoing.destroy(new Error("Proxy deadline exceeded")), timeoutMs);
      deadline.unref();
      try {
        const received = new Promise<void>((resolve, reject) => {
          outgoing.once("error", reject);
          outgoing.once("response", (incoming) => {
            status = incoming.statusCode ?? 502;
            response.writeHead(status, forwardHeaders(incoming.headers));
            void pipeline(incoming, output, response).then(resolve, reject);
          });
        });
        const sent = pipeline(request, input, outgoing);
        const results = await Promise.allSettled([sent, received]);
        if (results.some((result) => result.status === "rejected")) outcome = "transport_error_or_abort";
      } catch {
        outcome = "transport_error_or_abort";
      } finally {
        clearTimeout(deadline);
        response.off("close", abort);
        outgoing.destroy();
        if (!response.writableEnded && !response.destroyed) {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        }
      }
      try {
        const metadata = { id, startedAt, durationMs: Date.now() - start, method: request.method,
          route, status: status ?? null, outcome, captureBodies: options.captureBodies === true,
          request: input.summary(), response: output.summary() };
        if (options.captureBodies === true) {
          await writeFile(join(directory, `${id}.request.body`), Buffer.concat(input.chunks), { mode: 0o600, flag: "wx" });
          await writeFile(join(directory, `${id}.response.body`), Buffer.concat(output.chunks), { mode: 0o600, flag: "wx" });
        }
        await writeFile(join(directory, `${id}.json`), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      } catch {
        options.onLogError?.();
      }
    }
  });
  return { server, directory, flush: async () => { await Promise.all([...pending]); } };
}
