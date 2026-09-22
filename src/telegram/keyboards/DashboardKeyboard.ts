import { createHash } from "node:crypto";
import { InlineKeyboard } from "grammy";

import type { AllowedOperation, ProjectConfig } from "../../config/ProjectConfig.js";

export type DashboardAction = Extract<AllowedOperation, "task" | "status" | "git" | "diff" | "test" | "stop">;
interface DashboardCallback { readonly projectId: string; readonly action: DashboardAction; }

const ACTIONS: readonly [DashboardAction, string][] = [
  ["task", "New task"], ["status", "Status"], ["git", "Git"],
  ["diff", "Diff"], ["test", "Tests"], ["stop", "Stop"],
];
const PREFIX = "action:";
const PATTERN = /^action:[A-Za-z0-9_-]{22}$/u;

export class DashboardKeyboard {
  readonly #callbacks = new Map<string, DashboardCallback>();

  public build(project: ProjectConfig): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    let added = 0;
    for (const [action, label] of ACTIONS) {
      if (!project.allowedOperations.has(action)) continue;
      if (added > 0) keyboard.row();
      keyboard.text(label, this.callbackData(project.id, action));
      added += 1;
    }
    return keyboard;
  }

  public callbackData(projectId: string, action: DashboardAction): string {
    const token = createHash("sha256").update(`${projectId}\0${action}`).digest("base64url").slice(0, 22);
    const callback = `${PREFIX}${token}`;
    const existing = this.#callbacks.get(callback);
    if (existing !== undefined && (existing.projectId !== projectId || existing.action !== action)) {
      throw new Error("Dashboard callback identifier collision");
    }
    this.#callbacks.set(callback, { projectId, action });
    return callback;
  }

  public resolve(data: string | undefined): DashboardCallback | undefined {
    if (data === undefined || !PATTERN.test(data)) return undefined;
    return this.#callbacks.get(data);
  }
}
