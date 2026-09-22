import { InputFile, type Context } from "grammy";

import {
  AgentManagerError,
  type ProjectOperationCoordinator,
} from "../../agent/AgentManager.js";
import {
  ProjectCommandRunnerError,
} from "../../process/ProjectCommandRunner.js";
import type { ProcessResult } from "../../process/ProcessRunner.js";
import type { ProjectConfig } from "../../config/ProjectConfig.js";
import { MessageSender, type MessageTransport } from "../MessageSender.js";
import type { ProjectHandler } from "./ProjectHandler.js";

/** Runs only the selected project's configured test command. */
export class TestHandler {
  readonly #projects: ProjectHandler;
  readonly #commands: TestCommandRunner;
  readonly #operations: ProjectOperationCoordinator;
  readonly #messages: MessageSender;

  public constructor(
    projects: ProjectHandler,
    commands: TestCommandRunner,
    operations: ProjectOperationCoordinator,
    messages = new MessageSender(),
  ) {
    this.#projects = projects;
    this.#commands = commands;
    this.#operations = operations;
    this.#messages = messages;
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
    if (!project.allowedOperations.has("test") || project.testCommand === undefined) {
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
      await context.reply(testSummary(result));
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      await this.#messages.sendTestOutput(telegramTransport(context), output);
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

function testSummary(result: {
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly terminationReason?: "aborted" | "timed_out";
}): string {
  if (result.terminationReason === "timed_out") {
    return `Tests timed out after ${String(result.durationMs)} ms.`;
  }
  if (result.terminationReason === "aborted") {
    return "Tests stopped.";
  }
  if (result.exitCode === 0) {
    return `Tests passed in ${String(result.durationMs)} ms.`;
  }
  return `Tests failed (exit code ${String(result.exitCode)}) in ${String(result.durationMs)} ms.`;
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
