import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { stat } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { createReadStream as streamFile } from "node:fs";
import { basename, resolve } from "node:path";
import type { WebConfig } from "../config/AppConfig.js";
import { WebAuthService, CLEAR_SESSION_HEADERS, sessionCookie } from "./WebAuthService.js";
import type { WebSession } from "./WebSessionStore.js";
import type { AgentEventHub } from "../application/AgentEventHub.js";

const MAX_BODY = 64 * 1024;
const MAX_HEADERS = 16 * 1024;

export interface WebServerOptions {
  readonly config: WebConfig;
  readonly auth: WebAuthService;
  readonly staticDirectory?: string;
  readonly eventHub?: AgentEventHub;
  readonly requestHandler?: (request: WebRouteRequest) => Promise<WebRouteResponse>;
  readonly logger?: { warn(message: string, fields?: Readonly<Record<string, unknown>>): void };
  readonly maxConnections?: number;
}
export interface WebRouteRequest { readonly method: string; readonly path: string; readonly query: URLSearchParams; readonly session: WebSession; readonly body: unknown; readonly origin: string | undefined; }
export interface WebRouteResponse { readonly status: number; readonly body?: unknown; readonly headers?: Readonly<Record<string, string>>; }

/** Small same-origin Web transport. The domain remains behind requestHandler. */
export class WebServer {
  readonly #options: WebServerOptions; readonly #server: Server; readonly #connections = new Set<IncomingMessage>(); readonly #responses = new Set<ServerResponse>(); #sseConnections = 0; #stopping = false;
  public constructor(options: WebServerOptions) {
    this.#options = options;
    const config = options.config;
    if (config.environment === "production" && config.publicUrl.startsWith("http:")) throw new Error("Production Web requires HTTPS");
    if (config.tlsMode === "reverse-proxy" && !isLoopback(config.host) && !config.host.startsWith("unix:")) throw new Error("Reverse proxy must bind loopback or Unix socket");
    if (config.environment === "production" && config.tlsMode === "direct" && (config.tlsCertPath === undefined || config.tlsKeyPath === undefined)) throw new Error("TLS certificate and key are required");
    if (config.tlsMode === "direct" && config.environment === "production" && config.tlsKeyPath !== undefined && (statSync(config.tlsKeyPath).mode & 0o077) !== 0) throw new Error("TLS private key permissions are too broad");
    this.#server = config.tlsMode === "direct" && config.tlsCertPath !== undefined && config.tlsKeyPath !== undefined
      ? createHttpsServer({ cert: readFileSync(config.tlsCertPath), key: readFileSync(config.tlsKeyPath), maxHeaderSize: MAX_HEADERS }, (request, response) => void this.#handle(request, response))
      : createHttpServer({ maxHeaderSize: MAX_HEADERS }, (request, response) => void this.#handle(request, response));
    this.#server.maxConnections = options.maxConnections ?? 128;
    this.#server.requestTimeout = 15_000; this.#server.headersTimeout = 10_000; this.#server.keepAliveTimeout = 5_000;
    this.#server.on("connection", (socket) => { if (this.#stopping) socket.destroy(); });
  }
  public async start(): Promise<void> {
    if (this.#stopping) throw new Error("Web server is stopping");
    await new Promise<void>((resolvePromise, reject) => { const onError = (error: Error) => { this.#server.off("listening", onListening); reject(error); }; const onListening = () => { this.#server.off("error", onError); resolvePromise(); }; this.#server.once("error", onError); this.#server.once("listening", onListening); this.#server.listen(this.#options.config.port, this.#options.config.host); });
  }
  public async stop(): Promise<void> { this.#stopping = true; for (const response of this.#responses) response.destroy(); await new Promise<void>((resolvePromise) => this.#server.close(() => resolvePromise())); }
  public get address(): ReturnType<Server["address"]> { return this.#server.address(); }
  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.#connections.add(request); this.#responses.add(response); response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"); response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("X-Frame-Options", "DENY"); response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()"); response.setHeader("Cache-Control", "no-store"); if (this.#options.config.environment === "production") response.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      const host = request.headers.host; const expected = new URL(this.#options.config.publicUrl).host; if (host !== expected) return send(response, 400, { error: "invalid_host" });
      const url = new URL(request.url ?? "/", this.#options.config.publicUrl); const origin = request.headers.origin;
      if (origin !== undefined && origin !== new URL(this.#options.config.publicUrl).origin) return send(response, 403, { error: "invalid_origin" });
      if (url.pathname === "/health" && request.method === "GET") return send(response, 200, { status: "ok" });
      if (url.pathname === "/api/auth/login" && request.method === "POST") return this.#login(request, response);
      // Login page and bundled local assets are intentionally public; all
      // API, mutation, and event routes remain behind the session gate below.
      if (this.#options.staticDirectory !== undefined && request.method === "GET" && !url.pathname.startsWith("/api/") && url.pathname !== "/events") return this.#static(url.pathname, response);
      const session = this.#session(request);
      if (url.pathname === "/api/auth/logout" && request.method === "POST") { if (session) this.#requireCsrf(request, session); if (session) this.#options.auth.logout(session.id); response.setHeader("Set-Cookie", `${this.#cookieName()}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${this.#secureCookie() ? "; Secure" : ""}`); return send(response, 204, undefined, CLEAR_SESSION_HEADERS); }
      if (session === undefined) return send(response, 401, { error: "unauthorized" });
      if (request.method !== "GET") this.#requireCsrf(request, session);
      if (url.pathname === "/api/auth/reauth" && request.method === "POST") { const body = await readJson(request); const password = isRecord(body) && typeof body.password === "string" ? body.password : ""; const ok = await this.#options.auth.reauthenticate(session.id, request.socket.remoteAddress ?? "unknown", password); return ok ? send(response, 204, undefined) : send(response, 401, { error: "invalid_credentials" }); }
      if (url.pathname === "/api/auth/me" && request.method === "GET") return send(response, 200, { actor: "web:operator", csrfToken: session.csrfToken });
      if (url.pathname === "/events" && request.method === "GET") return this.#sse(response, session, url.searchParams.get("projectId"));
      if (this.#options.requestHandler !== undefined) { const body = await readJson(request); const result = await this.#options.requestHandler({ method: request.method ?? "GET", path: url.pathname, query: url.searchParams, session, body, origin }); return send(response, result.status, result.body, result.headers); }
      if (this.#options.staticDirectory !== undefined && request.method === "GET") return this.#static(url.pathname, response);
      return send(response, 404, { error: "not_found" });
    } catch (error) { this.#options.logger?.warn("Web request failed", { code: error instanceof Error ? error.name : "unknown" }); if (!response.headersSent) send(response, 400, { error: "bad_request" }); else response.destroy(); } finally { this.#connections.delete(request); if (response.writableEnded || response.destroyed) this.#responses.delete(response); }
  }
  async #login(request: IncomingMessage, response: ServerResponse): Promise<void> { const body = await readJson(request); const password = isRecord(body) && typeof body.password === "string" ? body.password : ""; const source = request.socket.remoteAddress ?? "unknown"; const result = await this.#options.auth.login(source, password); if (!result.ok || result.session === undefined) return send(response, 401, { error: "invalid_credentials" }); response.setHeader("Set-Cookie", sessionCookie(result.session.id, this.#secureCookie())); return send(response, 200, { csrfToken: result.session.csrfToken }); }
  #cookieName(): string { return this.#secureCookie() ? "__Host-codex_session" : "codex_session"; }
  #secureCookie(): boolean { return this.#options.config.environment === "production"; }
  #session(request: IncomingMessage): WebSession | undefined { const names = [this.#cookieName(), "__Host-codex_session"]; const value = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => names.some((name) => part.startsWith(`${name}=`))); const id = value?.slice(value.indexOf("=") + 1); return id === undefined ? undefined : this.#options.auth.session(id); }
  #requireCsrf(request: IncomingMessage, session: WebSession): void { if (request.headers["x-csrf-token"] !== session.csrfToken) throw new Error("csrf"); }
  async #sse(response: ServerResponse, session: WebSession, projectId: string | null): Promise<void> { void session; if (this.#sseConnections >= 32) { send(response, 429, { error: "too_many_connections" }); return; } this.#sseConnections += 1; response.statusCode = 200; response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Cache-Control", "no-store"); response.setHeader("Connection", "keep-alive"); response.write(`event: ready\ndata: ${JSON.stringify({ actor: "web:operator" })}\n\n`); const unsubscribe = this.#options.eventHub?.subscribe({ actorId: "web:operator", ...(projectId === null ? {} : { projectId }), onEvent: (event) => { if (!response.writableEnded) response.write(`event: agent\ndata: ${JSON.stringify(publicEvent(event))}\n\n`); } }); const timer = setInterval(() => response.write(": heartbeat\n\n"), 15_000); response.on("close", () => { clearInterval(timer); unsubscribe?.(); clearInterval(timer); this.#sseConnections -= 1; this.#responses.delete(response); }); }
  async #static(path: string, response: ServerResponse): Promise<void> { const root = resolve(this.#options.staticDirectory as string); const relative = path === "/" ? "index.html" : path.slice(1); if (relative.includes("..") || relative.includes("\\") || basename(relative) !== relative) { send(response, 404, { error: "not_found" }); return; } const file = resolve(root, relative); try { await stat(file); response.statusCode = 200; response.setHeader("Content-Type", contentType(relative)); streamFile(file).pipe(response); } catch { send(response, 404, { error: "not_found" }); } }
}

async function readJson(request: IncomingMessage): Promise<unknown> { let size = 0; const chunks: Buffer[] = []; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > MAX_BODY) throw new Error("body_too_large"); chunks.push(buffer); } if (chunks.length === 0) return undefined; if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) throw new Error("content_type"); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
function send(response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void { response.statusCode = status; for (const [key, value] of Object.entries(headers)) response.setHeader(key, value); if (body === undefined) { response.end(); return; } response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(JSON.stringify(body)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isLoopback(host: string): boolean { return host === "127.0.0.1" || host === "::1" || host === "localhost"; }
function contentType(file: string): string { if (file.endsWith(".html")) return "text/html; charset=utf-8"; if (file.endsWith(".js")) return "text/javascript; charset=utf-8"; if (file.endsWith(".css")) return "text/css; charset=utf-8"; return "application/octet-stream"; }
function publicEvent(event: import("../agent/AgentEvent.js").AgentEvent): Record<string, unknown> { switch (event.type) { case "progress": return { type: event.type, projectId: event.projectId, message: event.message.slice(0, 4_096), stage: event.stage }; case "question": return { type: event.type, projectId: event.projectId, questionId: event.questionId, question: event.question.slice(0, 4_096), choices: event.choices.slice(0, 20) }; case "completed": return { type: event.type, projectId: event.projectId, summary: event.summary.slice(0, 4_096) }; case "error": return { type: event.type, projectId: event.projectId, message: event.message.slice(0, 4_096), fatal: event.fatal }; default: return { type: event.type, projectId: event.projectId }; } }
