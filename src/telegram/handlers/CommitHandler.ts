import type { Context } from "grammy";

import type { AgentStatus } from "../../agent/AgentManager.js";
import type { GitService, GitStatus } from "../../git/GitService.js";
import type { ConfirmationHandler } from "./ConfirmationHandler.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import type { Confirmation } from "../../storage/Storage.js";

/** Builds a commit preview and requests confirmation; it never mutates Git. */
export class CommitHandler {
  readonly #projects: ProjectHandler;
  readonly #git: Pick<GitService, "getStagedStatus" | "commit">;
  readonly #operations: Pick<CommitOperationStatusReader, "getStatus">;
  readonly #confirmations: ConfirmationHandler;

  public constructor(
    projects: ProjectHandler,
    git: Pick<GitService, "getStagedStatus" | "commit">,
    operations: Pick<CommitOperationStatusReader, "getStatus">,
    confirmations: ConfirmationHandler,
  ) {
    this.#projects = projects;
    this.#git = git;
    this.#operations = operations;
    this.#confirmations = confirmations;
    this.#confirmations.registerOperation("commit", (context, decision, confirmation) =>
      this.#executeCommit(context, decision, confirmation, "Apply approved changes"),
    );
  }

  public async handleCommitCommand(context: Context): Promise<void> {
    const userId = context.from?.id;
    const project = userId === undefined
      ? undefined
      : await this.#projects.restoreActiveProject(userId);
    if (project === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }
    if (!project.allowedOperations.has("commit")) {
      await context.reply("Commit is not allowed for this project.");
      return;
    }

    let activity: AgentStatus;
    try {
      activity = this.#operations.getStatus(project.id);
    } catch {
      await context.reply("Unable to inspect the active operation.");
      return;
    }
    if (activity.active) {
      await context.reply("This project is busy with another operation.");
      return;
    }

    try {
      const status = await this.#git.getStagedStatus(project.path);
      if (status.clean) {
        await context.reply("No staged changes to commit.");
        return;
      }
      await this.#confirmations.request(
        context,
        project.id,
        "commit",
        formatPreview(status),
        (callbackContext, decision, confirmation) =>
          this.#executeCommit(callbackContext, decision, confirmation, readCommitMessage(context)),
      );
    } catch {
      await context.reply("Unable to prepare the commit preview.");
    }
  }

  async #executeCommit(
    context: Context,
    decision: "allow" | "deny",
    confirmation: Confirmation,
    message: string,
  ): Promise<void> {
    if (decision === "deny") {
      await context.reply("Commit canceled.");
      return;
    }
    try {
      const userId = context.from?.id;
      const project = userId === undefined
        ? undefined
        : await this.#projects.restoreActiveProject(userId);
      if (project === undefined || project.id !== confirmation.projectId) {
        await context.reply("This confirmation is no longer valid.");
        return;
      }
      await this.#git.commit(project.path, message);
      await context.reply("Commit created from staged changes.");
    } catch {
      await context.reply("Unable to create commit.");
    }
  }
}

export interface CommitOperationStatusReader {
  getStatus(projectId: string): AgentStatus;
}

function formatPreview(status: GitStatus): string {
  const branch = status.branch ?? "detached HEAD";
  const files = status.changedFiles.length;
  const binary = status.numstat.binaryFiles === 0
    ? ""
    : `, ${String(status.numstat.binaryFiles)} binary`;
  return [
    "Commit preview",
    `Branch: ${branch}`,
    `Files: ${String(files)}`,
    `Changes: +${String(status.numstat.additions)}/-${String(status.numstat.deletions)}${binary}`,
  ].join("\n");
}

function readCommitMessage(context: Context): string {
  const text = context.message?.text ?? "";
  const whitespace = text.search(/\s/u);
  const argument = whitespace < 0 ? "" : text.slice(whitespace + 1).trim();
  return argument.length === 0 ? "Apply approved changes" : argument.slice(0, 500);
}
