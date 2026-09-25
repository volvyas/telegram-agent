import { randomUUID } from "node:crypto";

import { InlineKeyboard, type Context } from "grammy";

import type { AgentManager } from "../../agent/AgentManager.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import type { ProgressReporter, ProgressTransport } from "../ProgressReporter.js";

const MAX_ANSWER_LENGTH = 32_000;
const CALLBACK_PREFIX = "answer:";

interface ChoiceCallback {
  readonly projectId: string;
  readonly questionId: string;
  readonly choice: string;
}

/** Routes text and opaque inline choices to the active project's pending question. */
export class AnswerHandler {
  readonly #agentManager: AgentManager;
  readonly #projects: ProjectHandler;
  readonly #choices = new Map<string, ChoiceCallback>();
  readonly #progress: ProgressReporter | undefined;

  public constructor(agentManager: AgentManager, projects: ProjectHandler, progress?: ProgressReporter) {
    this.#agentManager = agentManager;
    this.#projects = projects;
    this.#progress = progress;
  }

  public async handleAnswerCommand(context: Context): Promise<void> {
    const answer = commandArgument(context.message?.text);
    if (answer === undefined) {
      await context.reply("Usage: /answer <text>");
      return;
    }
    await this.#answerActiveProject(context, answer);
  }

  public async handleText(context: Context): Promise<void> {
    const text = normalize(context.message?.text);
    if (text !== undefined) await this.#answerActiveProject(context, text, true);
  }

  public async handleCallback(context: Context): Promise<void> {
    const data = context.callbackQuery?.data;
    const choice = data === undefined ? undefined : this.#choices.get(data);
    const userId = context.from?.id;
    const project = userId === undefined ? undefined : await this.#projects.restoreActiveProject(userId);
    if (choice === undefined || project?.id !== choice.projectId || userId === undefined) {
      await context.answerCallbackQuery({ text: "This answer is no longer available.", show_alert: true });
      return;
    }
    await context.answerCallbackQuery();
    await this.#submit(context, project.id, choice.questionId, choice.choice, userId);
  }

  public keyboard(projectId: string): InlineKeyboard | undefined {
    const pending = this.#agentManager.getSession(projectId)?.pendingQuestion;
    if (pending === undefined || pending.choices.length === 0) return undefined;
    const keyboard = new InlineKeyboard();
    for (const choice of pending.choices) {
      const callback = `${CALLBACK_PREFIX}${randomUUID()}`;
      this.#choices.set(callback, { projectId, questionId: pending.questionId, choice });
      keyboard.text(choice, callback).row();
    }
    return keyboard;
  }

  async #answerActiveProject(context: Context, answer: string, quietWhenNotWaiting = false): Promise<void> {
    const userId = context.from?.id;
    const project = userId === undefined ? undefined : await this.#projects.restoreActiveProject(userId);
    if (project === undefined || userId === undefined) {
      if (!quietWhenNotWaiting) await context.reply("Select a project first with /projects.");
      return;
    }
    const pending = await this.#agentManager.getPendingQuestion(project.id);
    if (pending === undefined) {
      if (!quietWhenNotWaiting) await context.reply("There is no pending question for this project.");
      return;
    }
    await this.#submit(context, project.id, pending.questionId, answer, userId);
  }

  async #submit(context: Context, projectId: string, questionId: string, answer: string, userId: number): Promise<void> {
    try {
      if (this.#progress !== undefined) {
        await this.#progress.start(projectId, progressTransport(context), "Answer sent. Continuing task…");
      }
      const task = await this.#agentManager.answerQuestion(projectId, questionId, answer, userId);
      await this.#progress?.flush(projectId);
      await context.reply(task.terminalEvent.type === "completed"
        ? `Task completed.\n${task.terminalEvent.summary}`
        : "Answer sent.");
    } catch {
      await context.reply("This answer is no longer valid.");
    } finally {
      this.#progress?.stop(projectId);
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

function commandArgument(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const firstWhitespace = text.search(/\s/u);
  return firstWhitespace < 0 ? undefined : normalize(text.slice(firstWhitespace + 1));
}

function normalize(value: string | undefined): string | undefined {
  const answer = value?.trim();
  return answer === undefined || answer.length === 0 || answer.length > MAX_ANSWER_LENGTH ? undefined : answer;
}
