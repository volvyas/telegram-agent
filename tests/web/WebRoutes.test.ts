import { describe, expect, it, vi } from "vitest";

import type { ApplicationUseCases } from "../../src/application/UseCases.js";
import { createWebRouteHandler } from "../../src/web/WebRoutes.js";

describe("WebRoutes", () => {
  it("passes the server-derived session bindings into confirmation use cases", async () => {
    const requestConfirmation = vi.fn(async (actor) => ({ actor }));
    const useCases = {
      confirmations: { request: requestConfirmation, consume: vi.fn() },
    } as unknown as ApplicationUseCases;
    const handler = createWebRouteHandler(useCases);

    const result = await handler({
      method: "POST",
      path: "/api/confirmations/request",
      query: new URLSearchParams(),
      session: {
        id: "session",
        securityContextId: "security-context",
        csrfToken: "csrf-token",
        lastAuthenticatedAt: 1,
        createdAt: 1,
        lastSeenAt: 1,
      },
      body: { projectId: "demo", operation: "commit", payload: { message: "safe" } },
      origin: "http://127.0.0.1:8080",
    });

    expect(result.status).toBe(200);
    expect(requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "web:operator", securityContextId: "security-context", csrfToken: "csrf-token" }),
      "demo",
      "commit",
      { message: "safe" },
    );
  });
});
