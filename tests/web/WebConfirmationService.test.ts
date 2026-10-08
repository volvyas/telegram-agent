import { describe, expect, it } from "vitest";

import { WebConfirmationService } from "../../src/web/WebConfirmationService.js";
import type { ActorContext } from "../../src/domain/Actor.js";

describe("WebConfirmationService", () => {
  it("binds a confirmation to the authenticated web security context and consumes once", () => {
    const actor: ActorContext = {
      actorId: "web:operator",
      origin: "web",
      securityContextId: "security-context",
      csrfToken: "csrf-token",
      authenticatedAt: 1_000,
    };
    const service = new WebConfirmationService({ now: () => 1_000 });
    const confirmation = service.create(actor, "demo", "commit", { message: "safe" });

    expect(service.consume(confirmation.id, actor, "demo", "commit", { message: "safe" })).toEqual(confirmation);
    expect(() => service.consume(confirmation.id, actor, "demo", "commit", { message: "safe" })).toThrow("confirmation_invalid");
  });

  it("rejects a different web security context or payload", () => {
    const actor: ActorContext = {
      actorId: "web:operator",
      origin: "web",
      securityContextId: "security-context",
      csrfToken: "csrf-token",
      authenticatedAt: 1_000,
    };
    const service = new WebConfirmationService({ now: () => 1_000 });
    const confirmation = service.create(actor, "demo", "commit", { message: "safe" });

    expect(() => service.consume(confirmation.id, { ...actor, securityContextId: "other" }, "demo", "commit", { message: "safe" })).toThrow("confirmation_invalid");
  });
});
