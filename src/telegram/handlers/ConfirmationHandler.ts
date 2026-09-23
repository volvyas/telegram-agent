import type { Context } from "grammy";

import {
  ConfirmationError,
  type ConfirmationService,
} from "../../confirmations/ConfirmationService.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import { ConfirmationKeyboard } from "../keyboards/ConfirmationKeyboard.js";
import type { Confirmation } from "../../storage/Storage.js";

const MAX_SUMMARY_LENGTH = 3_000;
export type ConfirmationAction = (
  context: Context,
  decision: "allow" | "deny",
  confirmation: Confirmation,
) => Promise<void>;

/** Presents and consumes Telegram confirmations; it never executes the operation itself. */
export class ConfirmationHandler {
  readonly #service: ConfirmationService;
  readonly #projects: ProjectHandler;
  readonly #keyboard: ConfirmationKeyboard;
  readonly #actions = new Map<string, { readonly confirmation: Confirmation; readonly action: ConfirmationAction }>();
  readonly #operationActions = new Map<string, ConfirmationAction>();

  public constructor(
    service: ConfirmationService,
    projects: ProjectHandler,
    keyboard = new ConfirmationKeyboard(),
  ) {
    this.#service = service;
    this.#projects = projects;
    this.#keyboard = keyboard;
  }

  public async request(
    context: Context,
    projectId: string,
    operation: string,
    summary: string,
    action?: ConfirmationAction,
  ): Promise<void> {
    const userId = context.from?.id;
    if (userId === undefined) {
      await context.reply("Unable to identify the Telegram user.");
      return;
    }
    const confirmation = await this.#service.request(userId, projectId, operation);
    if (action !== undefined) this.#actions.set(confirmation.id, { confirmation, action });
    const boundedSummary = summary.trim().slice(0, MAX_SUMMARY_LENGTH);
    await context.reply(
      `⚠️ Confirmation required\n\n${boundedSummary}\n\nThis confirmation expires soon.`,
      { reply_markup: this.#keyboard.build(confirmation) },
    );
  }

  public requestConfirmation(
    context: Context,
    projectId: string,
    operation: string,
    summary: string,
    action?: ConfirmationAction,
  ): Promise<void> {
    return this.request(context, projectId, operation, summary, action);
  }

  /** Registers the operation executor used when a persisted confirmation survives a restart. */
  public registerOperation(operation: string, action: ConfirmationAction): void {
    this.#operationActions.set(operation, action);
  }

  public async handleCallback(context: Context): Promise<void> {
    const callback = this.#keyboard.resolve(context.callbackQuery?.data);
    const userId = context.from?.id;
    const project = userId === undefined
      ? undefined
      : await this.#projects.restoreActiveProject(userId);
    if (callback === undefined || userId === undefined || project === undefined) {
      await context.answerCallbackQuery({ text: "This confirmation is no longer valid.", show_alert: true });
      return;
    }

    try {
      const pendingAction = this.#actions.get(callback.confirmationId);
      const pending = pendingAction?.confirmation ?? await this.#service.get(callback.confirmationId);
      const decision = await this.#service.consume({
        id: callback.confirmationId,
        userId,
        projectId: project.id,
        decision: callback.decision,
      });
      this.#actions.delete(callback.confirmationId);
      await context.answerCallbackQuery();
      const action = pendingAction?.action ?? this.#operationActions.get(pending?.operation ?? "");
      if (action !== undefined) {
        await action(context, decision, pending ?? {
          id: callback.confirmationId, userId, projectId: project.id,
          operation: "unknown", createdAt: "", expiresAt: "",
        });
      } else {
        await context.reply(decision === "allow" ? "Allowed once." : "Operation denied.");
      }
    } catch (error) {
      if (!(error instanceof ConfirmationError)) throw error;
      await context.answerCallbackQuery({ text: "This confirmation is no longer valid.", show_alert: true });
    }
  }

  public keyboard(confirmation: Parameters<ConfirmationKeyboard["build"]>[0]) {
    return this.#keyboard.build(confirmation);
  }
}
