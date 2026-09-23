import { describe, expect, it } from "vitest";

import {
  CONFIRMATION_REQUIRED_OPERATIONS,
  FORBIDDEN_OPERATIONS,
  OperationPolicy,
} from "../../src/policy/OperationPolicy.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";

const project: ProjectConfig = {
  id: "demo",
  name: "Demo",
  path: "/repo",
  allowedOperations: new Set(["task", "status", "commit"]),
};

describe("OperationPolicy", () => {
  const policy = new OperationPolicy();
  const classifications: readonly (readonly [string, string])[] = [
    ["task", "allowed"],
    ["status", "allowed"],
    ["commit", "confirmation_required"],
    ["not-configured", "forbidden"],
    ...FORBIDDEN_OPERATIONS.map((operation): readonly [string, string] => [operation, "forbidden"]),
  ];

  it.each(classifications)("classifies %s as %s", (operation, kind) => {
    expect(policy.evaluate(project, operation).kind).toBe(kind);
  });

  it("keeps the default destructive-operation deny list independent of project config", () => {
    const permissive = { ...project, allowedOperations: new Set(["task", "commit"]) } as ProjectConfig;
    for (const operation of FORBIDDEN_OPERATIONS) {
      expect(policy.evaluate(permissive, operation).kind).toBe("forbidden");
    }
    for (const operation of CONFIRMATION_REQUIRED_OPERATIONS) {
      expect(policy.requiresConfirmation(operation)).toBe(true);
    }
  });
});
