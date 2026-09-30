import type { Context } from "grammy";

import type { ProjectHandler } from "./ProjectHandler.js";
import type { PersistedTaskRecord } from "../../storage/Storage.js";

const MAX_RECORDS = 10;
const MAX_MESSAGE_LENGTH = 4_096;

export class LogHandler {
  readonly #projects: ProjectHandler;
  readonly #tasks: TaskHistoryReader;

  public constructor(projects: ProjectHandler, tasks: TaskHistoryReader) {
    this.#projects = projects;
    this.#tasks = tasks;
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
      const records = await this.#tasks.recent(project.id, MAX_RECORDS);
      await context.reply(formatLog(project.name, records));
    } catch {
      await context.reply("Unable to read task log.");
    }
  }
}

export interface TaskHistoryReader {
  recent(projectId: string, limit: number): Promise<readonly PersistedTaskRecord[]>;
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
