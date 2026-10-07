import type { ActorContext } from "../domain/Actor.js";
import type { ApplicationUseCases } from "../application/UseCases.js";
import type { WebRouteRequest, WebRouteResponse } from "./WebServer.js";

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** Authenticated same-origin adapter. It accepts only bounded IDs and text. */
export function createWebRouteHandler(useCases: ApplicationUseCases): (request: WebRouteRequest) => Promise<WebRouteResponse> {
  return async (request) => {
    const actor: ActorContext = { actorId: "web:operator", origin: "web", securityContextId: request.session.securityContextId };
    if (request.method === "GET" && request.path === "/api/projects") return response(200, (await useCases.projects.list(actor)).map((item) => ({ id: item.id, name: item.name, allowedOperations: [...item.allowedOperations], codexHome: item.codexHome === undefined ? "default" : codexIdentifier(item.codexHome) })));
    if (request.method === "POST" && request.path === "/api/projects/select") { const body = object(request.body, ["projectId"]); return response(200, await useCases.projects.select(actor, project(text(body.projectId, 64)))); }
    if (request.method === "GET" && request.path === "/api/status") return response(200, await useCases.agent.status(actor, project(query(request, "projectId"))));
    if (request.method === "POST" && request.path === "/api/task") { const body = object(request.body, ["projectId", "prompt"]); return response(200, taskView(await useCases.agent.startTask(actor, project(text(body.projectId, 64)), text(body.prompt, 12_000)))); }
    if (request.method === "POST" && request.path === "/api/question") { const body = object(request.body, ["projectId", "questionId", "answer"]); return response(200, taskView(await useCases.agent.answer(actor, project(text(body.projectId, 64)), text(body.questionId, 256), text(body.answer, 4_096)))); }
    if (request.method === "POST" && request.path === "/api/stop") { const body = object(request.body, ["projectId"]); return response(200, await useCases.agent.stop(actor, project(text(body.projectId, 64)))); }
    if (request.method === "GET" && request.path === "/api/git/status") return response(200, await useCases.git.status(actor, project(query(request, "projectId"))));
    if (request.method === "GET" && request.path === "/api/git/diff") return response(200, await useCases.git.diff(actor, project(query(request, "projectId"))));
    if (request.method === "GET" && request.path === "/api/git/log") return response(200, await useCases.git.log(actor, project(query(request, "projectId"))));
    if (request.method === "POST" && request.path === "/api/test") { const body = object(request.body, ["projectId"]); return response(202, await useCases.test.run(actor, project(text(body.projectId, 64)))); }
    return response(404, { error: "not_found" });
  };
}

function response(status: number, body: unknown): WebRouteResponse { return { status, body }; }
function taskView(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return { outcome: "completed" };
  const record = value as Record<string, unknown>;
  const event = typeof record.terminalEvent === "object" && record.terminalEvent !== null ? record.terminalEvent as Record<string, unknown> : undefined;
  const type = typeof event?.type === "string" ? event.type : undefined;
  return { id: typeof record.id === "string" ? record.id : undefined, outcome: type === "completed" ? "completed" : type === "question" ? "question" : type === "stopped" ? "stopped" : type === "error" ? "failed" : "completed", summary: typeof event?.summary === "string" ? event.summary.slice(0, 8_000) : undefined, question: typeof event?.question === "string" ? event.question.slice(0, 4_000) : undefined, message: typeof event?.message === "string" ? event.message.slice(0, 4_000) : undefined };
}
function query(request: WebRouteRequest, name: string): string { return text(request.query.get(name), 64); }
function project(value: string): string { if (!PROJECT_ID.test(value)) throw new Error("invalid_project"); return value; }
function text(value: unknown, max: number): string { if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error("invalid_text"); return value; }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_body"); const record = value as Record<string, unknown>; if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error("unknown_field"); return record; }
function codexIdentifier(codexHome: string): string { const value = codexHome.replace(/[\\/]+$/u, ""); const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")); const component = value.slice(separator + 1).replace(/[\u0000-\u001f\u007f]/gu, "").trim(); const display = component.replace(/^\.(?:codex|claude)-/u, ""); return display.length === 0 ? "configured" : display.slice(0, 128); }
