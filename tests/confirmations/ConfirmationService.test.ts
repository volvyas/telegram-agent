import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfirmationService } from "../../src/confirmations/ConfirmationService.js";
import { JsonStorage } from "../../src/storage/JsonStorage.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ConfirmationService", () => {
  it("persists an opaque confirmation and atomically consumes allow once", async () => {
    const storage = new JsonStorage(await dataDirectory());
    const service = new ConfirmationService(storage, {
      clock: () => new Date("2026-09-23T10:00:00.000Z"),
      idFactory: () => "opaque-confirmation-001",
    });
    const pending = await service.request(42, "api", "commit");
    expect(pending).toMatchObject({ userId: 42, projectId: "api", operation: "commit" });
    await expect(service.consume(pending.id, 42, "api", "allow")).resolves.toBe("allow");
    await expect(service.consume(pending.id, 42, "api", "allow")).rejects.toMatchObject({ code: "CONFIRMATION_NOT_FOUND" });
    await storage.close();
  });

  it("rejects wrong ownership without consuming, and supports deny", async () => {
    const storage = new JsonStorage(await dataDirectory());
    const service = new ConfirmationService(storage, { idFactory: () => "opaque-confirmation-002" });
    const pending = await service.request(42, "api", "run");
    await expect(service.consume(pending.id, 99, "api", "allow")).rejects.toMatchObject({ code: "CONFIRMATION_WRONG_USER" });
    await expect(service.consume(pending.id, 42, "web", "allow")).rejects.toMatchObject({ code: "CONFIRMATION_WRONG_PROJECT" });
    await expect(service.consume(pending.id, 42, "api", "deny")).resolves.toBe("deny");
    await storage.close();
  });

  it("removes expired confirmations and serializes simultaneous callbacks", async () => {
    let now = new Date("2026-09-23T10:00:00.000Z");
    const storage = new JsonStorage(await dataDirectory());
    const service = new ConfirmationService(storage, {
      clock: () => now,
      ttlMs: 1_000,
      idFactory: () => "opaque-confirmation-003",
    });
    const pending = await service.request(42, "api", "stop");
    now = new Date("2026-09-23T10:00:01.000Z");
    await expect(service.consume(pending.id, 42, "api", "allow")).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    await expect(Promise.allSettled([
      service.consume(pending.id, 42, "api", "allow"),
      service.consume(pending.id, 42, "api", "deny"),
    ])).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]));
    await storage.close();
  });
});

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-confirmation-test-"));
  directories.push(root);
  return join(root, "data");
}
