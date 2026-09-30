import type { Context } from "grammy";
import type { ProjectHandler } from "./ProjectHandler.js";
import type { ConfirmationHandler } from "./ConfirmationHandler.js";
import type { IssueCreationService } from "../../issues/IssueCreationService.js";
import { IssueCreationError } from "../../issues/IssueCreationService.js";
import type { IssueCreationProposal } from "../../issues/IssueWriter.js";
import type { AgentIssueProposalEvent } from "../../agent/AgentEvent.js";

/** Turns an already typed agent proposal into preview + one-shot confirmation. */
export class IssueCreationHandler {
  readonly #projects: ProjectHandler;
  readonly #confirmations: ConfirmationHandler;
  readonly #service: IssueCreationService;
  public constructor(projects: ProjectHandler, confirmations: ConfirmationHandler, service: IssueCreationService) {
    this.#projects = projects; this.#confirmations = confirmations; this.#service = service;
  }
  public async present(context: Context, event: AgentIssueProposalEvent | IssueCreationProposal): Promise<void> {
    try {
      await this.#present(context, event);
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? ` (${error.code})`
        : "";
      await context.reply(`Issue proposal could not be prepared${code}. No issue was created; please retry with a bounded proposal.`);
    }
  }

  async #present(context: Context, event: AgentIssueProposalEvent | IssueCreationProposal): Promise<void> {
    let proposal: IssueCreationProposal;
    try {
      proposal = "type" in event
        ? this.#service.propose(event.projectId, event.proposal.provider, event.proposal.draft)
        : this.#service.propose(event.projectId, event.provider, event.draft);
    } catch (error) {
      if (error instanceof IssueCreationError) {
        await context.reply("Issue proposal rejected before confirmation. Please retry with a bounded proposal containing no local paths, secrets, or raw logs.");
        return;
      }
      throw error;
    }
    const userId = context.from?.id;
    const project = userId === undefined ? undefined : await this.#projects.restoreActiveProject(userId);
    if (project === undefined || project.id !== proposal.projectId) { await context.reply("Issue proposal is no longer associated with the active project."); return; }
    const preview = `Create issue in ${proposal.provider}\n\nSummary: ${proposal.draft.summary}\n\n${proposal.draft.description}`;
    await this.#confirmations.request(context, project.id, "issue:create", preview, async (actionContext, decision, confirmation) => {
      if (decision === "deny") { await actionContext.reply("Issue creation denied."); return; }
      try {
        const created = await this.#service.create(proposal, confirmation.projectId, confirmation.id);
        await actionContext.reply(`Issue created: ${created.url}`);
      } catch { await actionContext.reply("Issue creation failed; no automatic retry was performed."); }
    });
  }
}
