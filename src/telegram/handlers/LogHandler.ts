import type { Context } from "grammy";

import type { ProjectHandler } from "./ProjectHandler.js";
import type { PersistedTaskRecord, Storage } from "../../storage/Storage.js";

const MAX_RECORDS = 10;
const MAX_MESSAGE_LENGTH = 4_096;

export class LogHandler {
  readonly #projects: ProjectHandler;
  readonly #storage: Storage;

  public constructor(projects: ProjectHandler, storage: Storage) {
    this.#projects = projects;
    this.#storage = storage;
  }

  public async handleLogCommand(context: Context): Promise<void> {
    const userId = context.from?.id;
    const project = userId === undefined
      ? undefined
      : await this.#projects.restoreActiveProject(userId);
    if (project === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }

    try {
      const records = (await this.#storage.load()).tasks
        .filter((record) => record.projectId === project.id)
        .slice(-MAX_RECORDS)
        .reverse();
      await context.reply(formatLog(project.name, records));
    } catch {
      await context.reply("Unable to read task log.");
    }
  }
}

function formatLog(projectName: string, records: readonly PersistedTaskRecord[]): string {
  if (records.length === 0) return `Task log: ${projectName}\nNo task records.`;
  const lines = records.map((record) =>
    `• ${record.id} · ${record.status} · ${safeSummary(record.promptSummary)} · ${record.updatedAt}`,
  );
  const result = [`Task log: ${projectName}`, ...lines].join("\n");
  return result.length <= MAX_MESSAGE_LENGTH
    ? result
    : `${result.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

function safeSummary(summary: string): string {
  const normalized = [...summary]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .trim()
    .replaceAll("  ", " ");
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}…`;
}
