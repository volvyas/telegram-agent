import type { Context } from "grammy";

import type { AgentManager } from "../../agent/AgentManager.js";
import type { AgentEvent } from "../../agent/AgentEvent.js";
import type { ProjectHandler } from "./ProjectHandler.js";

const MAX_TASK_LENGTH = 32_000;
const MAX_TELEGRAM_MESSAGE_LENGTH = 4_096;

export class TaskHandler {
  readonly #agentManager: AgentManager;
  readonly #projectHandler: ProjectHandler;
  readonly #pendingTaskUsers = new Set<number>();

  public constructor(agentManager: AgentManager, projectHandler: ProjectHandler) {
    this.#agentManager = agentManager;
    this.#projectHandler = projectHandler;
  }

  public async handleTaskCommand(context: Context): Promise<void> {
    const userId = context.from?.id;
    if (userId === undefined || this.#projectHandler.getActiveProject(userId) === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }

    const commandArgument = readTaskCommandArgument(context.message?.text);
    if (commandArgument === undefined) {
      this.#pendingTaskUsers.add(userId);
      await context.reply("Send the task description in your next message.");
      return;
    }
    const prompt = normalizePrompt(commandArgument);
    if (prompt === undefined) {
      await context.reply("Task description must be non-empty and at most 32000 characters.");
      return;
    }

    await this.#runTask(context, userId, prompt);
  }

  public async handleText(context: Context): Promise<void> {
    const userId = context.from?.id;
    if (userId === undefined || !this.#pendingTaskUsers.delete(userId)) {
      return;
    }

    const prompt = normalizePrompt(context.message?.text);
    if (prompt === undefined) {
      await context.reply("Task description must be non-empty and at most 32000 characters.");
      return;
    }

    await this.#runTask(context, userId, prompt);
  }

  async #runTask(
    context: Context,
    userId: number,
    prompt: string,
  ): Promise<void> {
    const project = this.#projectHandler.getActiveProject(userId);
    if (project === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }

    await context.reply(`Task started for ${project.name}.`);
    try {
      await this.#agentManager.startTask(project.id, prompt);
      const terminalEvent = this.#agentManager.getSession(project.id)?.lastEvent;
      await context.reply(formatTerminalEvent(terminalEvent));
    } catch {
      await context.reply("Task failed.");
    }
  }
}

function readTaskCommandArgument(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const firstWhitespace = text.search(/\s/u);
  if (firstWhitespace < 0) {
    return undefined;
  }
  const argument = text.slice(firstWhitespace + 1).trim();
  return argument.length === 0 ? undefined : argument;
}

function normalizePrompt(value: string | undefined): string | undefined {
  const prompt = value?.trim();
  return prompt === undefined || prompt.length === 0 || prompt.length > MAX_TASK_LENGTH
    ? undefined
    : prompt;
}

function formatTerminalEvent(event: AgentEvent | undefined): string {
  let message: string;
  switch (event?.type) {
    case "completed":
      message = `Task completed.\n${event.summary}`;
      break;
    case "error":
      message = event.fatal ? `Task failed.\n${event.message}` : "Task failed.";
      break;
    case "stopped":
      message = "Task stopped.";
      break;
    case "question":
      message = `Task needs input.\n${event.question}`;
      break;
    default:
      message = "Task failed.";
  }
  return message.length <= MAX_TELEGRAM_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_TELEGRAM_MESSAGE_LENGTH - 1)}…`;
}
