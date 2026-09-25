import { InputFile, type Context } from "grammy";

import {
  AgentManagerError,
  type ProjectOperationCoordinator,
} from "../../agent/AgentManager.js";
import {
  ProjectCommandRunnerError,
} from "../../process/ProjectCommandRunner.js";
import type { ProcessResult } from "../../process/ProcessRunner.js";
import { formatTestOutput } from "../../process/TestOutputFormatter.js";
import type { ProjectConfig } from "../../config/ProjectConfig.js";
import { MessageSender, type MessageTransport } from "../MessageSender.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import { DEFAULT_OPERATION_POLICY, type OperationPolicy } from "../../policy/OperationPolicy.js";

/** Runs only the selected project's configured test command. */
export class TestHandler {
  readonly #projects: ProjectHandler;
  readonly #commands: TestCommandRunner;
  readonly #operations: ProjectOperationCoordinator;
  readonly #messages: MessageSender;
  readonly #policy: OperationPolicy;

  public constructor(
    projects: ProjectHandler,
    commands: TestCommandRunner,
    operations: ProjectOperationCoordinator,
    messages = new MessageSender(),
    policy = DEFAULT_OPERATION_POLICY,
  ) {
    this.#projects = projects;
    this.#commands = commands;
    this.#operations = operations;
    this.#messages = messages;
    this.#policy = policy;
  }

  public async handleTestCommand(context: Context): Promise<void> {
    const userId = context.from?.id;
    const project = userId === undefined
      ? undefined
      : await this.#projects.restoreActiveProject(userId);
    if (project === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }
    if (this.#policy.evaluate(project, "test").kind === "forbidden" || project.testCommand === undefined) {
      await context.reply("No test command is configured for this project.");
      return;
    }

    await context.reply("Tests started…");
    try {
      const result = await this.#operations.runExclusive(
        project.id,
        "test",
        (signal) => this.#commands.run(project, "test", { signal }),
      );
      const output = formatTestOutput(result, project.path);
      await context.reply(output.message);
      if (output.diagnostic !== undefined) {
        await this.#messages.sendTestOutput(
          telegramTransport(context),
          output.diagnostic,
        );
      }
    } catch (error) {
      if (error instanceof AgentManagerError && error.code === "OPERATION_ACTIVE") {
        await context.reply("This project is busy with another operation.");
        return;
      }
      if (error instanceof ProjectCommandRunnerError && error.code === "COMMAND_NOT_CONFIGURED") {
        await context.reply("No test command is configured for this project.");
        return;
      }
      await context.reply("Unable to run tests.");
    }
  }
}

export interface TestCommandRunner {
  run(
    project: ProjectConfig,
    operation: "test",
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProcessResult>;
}

function telegramTransport(context: Context): MessageTransport {
  return {
    async sendText(text) { await context.reply(text); },
    async sendDocument(path, options) {
      await context.replyWithDocument(new InputFile(path, options.filename), {
        caption: options.caption,
      });
    },
  };
}
