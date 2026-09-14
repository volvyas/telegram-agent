import { createHash } from "node:crypto";

import { InlineKeyboard } from "grammy";

import type { ProjectConfig } from "../../config/ProjectConfig.js";

const CALLBACK_PREFIX = "project:";
const TOKEN_LENGTH = 22;
const CALLBACK_PATTERN = /^project:[A-Za-z0-9_-]{22}$/;

export class ProjectKeyboard {
  readonly #projectIdsByCallback = new Map<string, string>();

  public build(projects: readonly ProjectConfig[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    for (const project of projects) {
      keyboard.text(project.name, this.callbackData(project.id)).row();
    }

    return keyboard;
  }

  public callbackData(projectId: string): string {
    const token = createHash("sha256")
      .update(projectId)
      .digest("base64url")
      .slice(0, TOKEN_LENGTH);
    const callbackData = `${CALLBACK_PREFIX}${token}`;
    const existingProjectId = this.#projectIdsByCallback.get(callbackData);

    if (existingProjectId !== undefined && existingProjectId !== projectId) {
      throw new Error("Project callback identifier collision");
    }
    this.#projectIdsByCallback.set(callbackData, projectId);
    return callbackData;
  }

  public resolve(callbackData: string): string | undefined {
    if (!CALLBACK_PATTERN.test(callbackData)) {
      return undefined;
    }
    return this.#projectIdsByCallback.get(callbackData);
  }
}
