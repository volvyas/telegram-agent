import { describe, expect, it } from "vitest";

import {
  createEmptyPersistedState,
  type PersistedState,
  type Storage,
} from "../../src/storage/Storage.js";

export interface StorageContractHarness {
  readonly create: () => Promise<Storage>;
  readonly reopen: () => Promise<Storage>;
}

/** Reusable behavioral contract for every Storage implementation. */
export function defineStorageContract(
  name: string,
  createHarness: () => Promise<StorageContractHarness>,
): void {
  describe(`${name} Storage contract`, () => {
    it("starts with the versioned empty state", async () => {
      const harness = await createHarness();
      const storage = await harness.create();
      await expect(storage.load()).resolves.toEqual(createEmptyPersistedState());
      await storage.close();
    });

    it("atomically updates state and persists it across instances", async () => {
      const harness = await createHarness();
      const storage = await harness.create();
      const timestamp = "2026-09-15T10:00:00.000Z";
      await storage.update((state) => withActiveProject(state, timestamp));
      await storage.close();

      const reopened = await harness.reopen();
      await expect(reopened.load()).resolves.toMatchObject({
        activeProjects: { "42": { projectId: "demo", updatedAt: timestamp } },
        sequence: { nextTaskNumber: 2 },
      });
      await reopened.close();
    });

    it("does not commit a failed update", async () => {
      const harness = await createHarness();
      const storage = await harness.create();
      await expect(
        storage.update(() => {
          throw new Error("mutation failed");
        }),
      ).rejects.toThrow("mutation failed");
      await expect(storage.load()).resolves.toEqual(createEmptyPersistedState());
      await storage.close();
    });

    it("returns isolated immutable snapshots", async () => {
      const harness = await createHarness();
      const storage = await harness.create();
      const snapshot = await storage.load();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.sequence)).toBe(true);
      expect(() => {
        (snapshot.sequence as { nextTaskNumber: number }).nextTaskNumber = 99;
      }).toThrow(TypeError);
      await expect(storage.load()).resolves.toEqual(createEmptyPersistedState());
      await storage.close();
    });

    it("rejects operations after close", async () => {
      const harness = await createHarness();
      const storage = await harness.create();
      await storage.close();
      await expect(storage.load()).rejects.toMatchObject({ code: "STORAGE_CLOSED" });
    });
  });
}

function withActiveProject(state: PersistedState, updatedAt: string): PersistedState {
  return {
    ...state,
    activeProjects: {
      ...state.activeProjects,
      "42": { projectId: "demo", updatedAt },
    },
    sequence: { nextTaskNumber: 2 },
  };
}
