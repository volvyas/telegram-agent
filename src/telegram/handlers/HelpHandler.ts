import type { Context } from "grammy";

const DEFAULT_COMMANDS = [
  "start", "projects", "project", "task", "answer", "status", "git",
  "diff", "test", "stop", "help", "log", "continue",
] as const;

export class HelpHandler {
  readonly #commands: readonly string[];

  public constructor(commands: readonly string[] = DEFAULT_COMMANDS) {
    this.#commands = Object.freeze([...new Set(commands)].sort());
  }

  public async handleHelpCommand(context: Context): Promise<void> {
    await context.reply([
      "Available commands:",
      ...this.#commands.map((command) => `/${command}`),
    ].join("\n"));
  }
}
