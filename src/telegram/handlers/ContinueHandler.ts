import type { Context } from "grammy";

import type { AgentManager } from "../../agent/AgentManager.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import type { ProgressReporter, ProgressTransport } from "../ProgressReporter.js";
import { DEFAULT_OPERATION_POLICY, type OperationPolicy } from "../../policy/OperationPolicy.js";
import type { IssueCreationHandler } from "./IssueCreationHandler.js";

export class ContinueHandler {
  readonly #agent: AgentManager;
  readonly #projects: ProjectHandler;
  readonly #progress: ProgressReporter | undefined;
  readonly #policy: OperationPolicy;

  readonly #issueCreation: IssueCreationHandler | undefined;
  public constructor(agent: AgentManager, projects: ProjectHandler, progress?: ProgressReporter, policy = DEFAULT_OPERATION_POLICY, issueCreation?: IssueCreationHandler) {
    this.#agent = agent;
    this.#projects = projects;
    this.#progress = progress;
    this.#policy = policy;
    this.#issueCreation = issueCreation;
  }

  public async handleContinueCommand(context: Context): Promise<void> {
    const userId = context.from?.id;
    const project = userId === undefined
      ? undefined
      : await this.#projects.restoreActiveProject(userId);
    if (project === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }
    if (this.#policy.evaluate(project, "task").kind === "forbidden") {
      await context.reply("Tasks are not allowed for this project.");
      return;
    }
    const session = await this.#agent.getSessionForContinuation(project.id);
    if (session?.threadId === undefined) {
      await context.reply("This project has no resumable session.");
      return;
    }
    if (session.state === "WAITING_FOR_USER") {
      await context.reply("This session is waiting for an answer. Use /answer first.");
      return;
    }
    if (session.state === "RUNNING") {
      await context.reply("This project already has an active operation.");
      return;
    }

    if (this.#progress === undefined) await context.reply("Continuing the previous session…");
    else await this.#progress.start(project.id, progressTransport(context), "Continuing the previous session…");
    try {
      const task = await this.#agent.startTask(project.id, "Continue the previous task.", userId);
      await this.#progress?.flush(project.id);
      if (task.terminalEvent.type === "issue_proposal") {
        await this.#issueCreation?.present(context, task.terminalEvent);
      } else {
        await context.reply(task.terminalEvent.type === "completed"
          ? `Task completed.\n${task.terminalEvent.summary}`
          : "Session continued.");
      }
    } catch {
      await context.reply("Unable to continue this session.");
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
      if (chatId !== undefined) await context.api.editMessageText(chatId, message.messageId, text);
    },
  };
}
