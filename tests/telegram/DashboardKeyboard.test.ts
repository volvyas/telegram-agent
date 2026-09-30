import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import { DashboardKeyboard } from "../../src/telegram/keyboards/DashboardKeyboard.js";

describe("DashboardKeyboard", () => {
  it("uses bounded opaque callbacks and resolves the configured action", () => {
    const keyboard = new DashboardKeyboard();
    const project: ProjectConfig = {
      id: "private-project", name: "Private", path: "/secret/path",
      allowedOperations: new Set(["status", "diff"]),
    };
    const callback = keyboard.callbackData(project.id, "status");
    expect(callback).toMatch(/^action:[A-Za-z0-9_-]{22}$/u);
    expect(callback).not.toContain(project.id);
    expect(callback).not.toContain(project.path);
    expect(keyboard.resolve(callback)).toEqual({ projectId: project.id, action: "status" });
    expect(keyboard.resolve("action:forged")).toBeUndefined();
  });
});
