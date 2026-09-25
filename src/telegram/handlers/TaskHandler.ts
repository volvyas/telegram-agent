import type { Context } from "grammy";

import type { AgentManager } from "../../agent/AgentManager.js";
import type { AgentEvent } from "../../agent/AgentEvent.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import type { AnswerHandler } from "./AnswerHandler.js";
import type { ProgressReporter, ProgressTransport } from "../ProgressReporter.js";

const MAX_TASK_LENGTH = 32_000;
const MAX_TELEGRAM_MESSAGE_LENGTH = 4_096;

export class TaskHandler {
  readonly #agentManager: AgentManager;
  readonly #projectHandler: ProjectHandler;
  readonly #pendingTaskUsers = new Set<number>();
  readonly #answerHandler: AnswerHandler | undefined;
  readonly #progress: ProgressReporter | undefined;

  public constructor(agentManager: AgentManager, projectHandler: ProjectHandler, answerHandler?: AnswerHandler, progress?: ProgressReporter) {
    this.#agentManager = agentManager;
    this.#projectHandler = projectHandler;
    this.#answerHandler = answerHandler;
    this.#progress = progress;
  }

  public async handleTaskCommand(context: Context): Promise<void> {
    const userId = context.from?.id;
    if (userId === undefined || await this.#projectHandler.restoreActiveProject(userId) === undefined) {
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

  public async handleText(context: Context): Promise<boolean> {
    const userId = context.from?.id;
    if (userId === undefined || !this.#pendingTaskUsers.delete(userId)) {
      return false;
    }

    const prompt = normalizePrompt(context.message?.text);
    if (prompt === undefined) {
      await context.reply("Task description must be non-empty and at most 32000 characters.");
      return true;
    }

    await this.#runTask(context, userId, prompt);
    return true;
  }

  async #runTask(
    context: Context,
    userId: number,
    prompt: string,
  ): Promise<void> {
    const project = await this.#projectHandler.restoreActiveProject(userId);
    if (project === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }

    const initialText = `Task started for ${project.name}.`;
    if (this.#progress === undefined) await context.reply(initialText);
    else await this.#progress.start(project.id, progressTransport(context), initialText);
    try {
      const task = await this.#agentManager.startTask(project.id, prompt, userId);
      await this.#progress?.flush(project.id);
      const message = formatTerminalEvent(task.terminalEvent);
      const keyboard = task.terminalEvent.type === "question"
        ? this.#answerHandler?.keyboard(project.id)
        : undefined;
      if (keyboard === undefined) {
        await context.reply(message);
      } else {
        await context.reply(message, { reply_markup: keyboard });
      }
    } catch {
      await context.reply("Task failed.");
    } finally {
      this.#progress?.stop(project.id);
    }
  }
}

function progressTransport(context: Context): ProgressTransport {
  return {
    async send(text) {
      const message = await context.reply(text);
      return typeof message.message_id === "number" ? { messageId: message.message_id } : undefined;
    },
    async edit(message, text) {
      const chatId = context.chat?.id;
      if (chatId === undefined) return;
      await context.api.editMessageText(chatId, message.messageId, text);
    },
  };
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
