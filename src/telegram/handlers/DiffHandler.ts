import { InputFile, type Context } from "grammy";

import type { GitDiffReader } from "../../git/GitService.js";
import {
  MessageSender,
  type MessageTransport,
} from "../MessageSender.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import { DEFAULT_OPERATION_POLICY, type OperationPolicy } from "../../policy/OperationPolicy.js";

export class DiffHandler {
  readonly #projects: ProjectHandler;
  readonly #git: GitDiffReader;
  readonly #messages: MessageSender;
  readonly #policy: OperationPolicy;

  public constructor(
    projects: ProjectHandler,
    git: GitDiffReader,
    messages = new MessageSender(),
    policy = DEFAULT_OPERATION_POLICY,
  ) {
    this.#projects = projects;
    this.#git = git;
    this.#messages = messages;
    this.#policy = policy;
  }

  public async handleDiffCommand(context: Context): Promise<void> {
    const userId = context.from?.id;
    const project = userId === undefined
      ? undefined
      : await this.#projects.restoreActiveProject(userId);
    if (project === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }
    if (this.#policy.evaluate(project, "diff").kind === "forbidden") {
      await context.reply("Diff is not allowed for this project.");
      return;
    }

    try {
      const diff = await this.#git.getDiff(project.path);
      await this.#messages.sendDiff(telegramTransport(context), diff.content);
    } catch {
      await context.reply("Unable to send Git diff.");
    }
  }
}

function telegramTransport(context: Context): MessageTransport {
  return {
    async sendText(text) {
      await context.reply(text);
    },
    async sendDocument(path, options) {
      await context.replyWithDocument(
        new InputFile(path, options.filename),
        { caption: options.caption },
      );
    },
  };
}
