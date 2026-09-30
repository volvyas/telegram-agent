import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { randomUUID } from "node:crypto";

import {
  createIssueReference,
  IssueTrackerError,
  type IssuePage,
  type PageToken,
} from "../../issues/IssueTracker.js";
import { MessageSender } from "../MessageSender.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import { IssueFormatter } from "../IssueFormatter.js";
import type { IssueTrackerResolver } from "../../issues/IssueTrackerResolver.js";

const MAX_REFERENCE_LENGTH = 32;
const MAX_PAGE_MESSAGE_LENGTH = 3_800;
const PAGE_CALLBACK_TTL_MS = 2 * 60 * 1_000;
const MAX_CALLBACKS = 1_000;
const CALLBACK_PREFIX = "issue-page:";
const CALLBACK_PATTERN = /^issue-page:[A-Za-z0-9_-]{22,64}$/u;

export interface IssueTrackerHandlerOptions {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  readonly callbackTtlMs?: number;
  readonly maxPageDepth?: number;
}

interface PageCallback {
  readonly userId: number;
  readonly projectId: string;
  readonly provider: "github";
  readonly queryKind: "assigned-to-me";
  readonly page?: PageToken;
  readonly depth: number;
  readonly expiresAt: number;
}

export class IssueTrackerHandler {
  readonly #projects: ProjectHandler;
  readonly #resolver: IssueTrackerResolver;
  readonly #sender: MessageSender;
  readonly #formatter: IssueFormatter;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #callbackTtlMs: number;
  readonly #maxPageDepth: number;
  readonly #callbacks = new Map<string, PageCallback>();

  public constructor(
    projects: ProjectHandler,
    resolver: IssueTrackerResolver,
    sender = new MessageSender(),
    formatter = new IssueFormatter(),
    options: IssueTrackerHandlerOptions = {},
  ) {
    this.#projects = projects;
    this.#resolver = resolver;
    this.#sender = sender;
    this.#formatter = formatter;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#callbackTtlMs = options.callbackTtlMs ?? PAGE_CALLBACK_TTL_MS;
    this.#maxPageDepth = options.maxPageDepth ?? 10;
  }

  public async handleIssueCommand(context: Context): Promise<void> {
    const userId = context.from?.id;
    const project = userId === undefined
      ? undefined
      : await this.#projects.restoreActiveProject(userId);
    if (userId === undefined || project === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }

    const argument = readIssueCommandArgument(context.message?.text);
    if (argument === "mine") {
      await this.#handleAssignedToMe(context, project.id, userId);
      return;
    }
    const reference = readIssueReference(argument);
    if (reference === undefined) {
      await context.reply("Usage: /issue <issue number>");
      return;
    }

    try {
      const tracker = this.#resolver.resolve(project);
      const issue = await tracker.getIssue(createIssueReference(reference));
      await this.#sender.sendLongMessage({
        async sendText(text) { await context.reply(text); },
      }, this.#formatter.format(issue));
    } catch (error) {
      await context.reply(issueErrorMessage(error));
    }
  }

  public async handleIssuePageCallback(context: Context): Promise<void> {
    const data = context.callbackQuery?.data;
    const userId = context.from?.id;
    const callback = data === undefined || !CALLBACK_PATTERN.test(data)
      ? undefined
      : this.#callbacks.get(data);
    const project = userId === undefined
      ? undefined
      : await this.#projects.restoreActiveProject(userId);
    if (
      callback === undefined ||
      userId === undefined ||
      callback.userId !== userId ||
      project === undefined ||
      callback.projectId !== project.id ||
      callback.provider !== project.issueTracker?.type ||
      callback.queryKind !== "assigned-to-me" ||
      callback.expiresAt <= this.#clock().valueOf() ||
      callback.depth > this.#maxPageDepth
    ) {
      await context.answerCallbackQuery({ text: "This issue page is no longer available.", show_alert: true });
      return;
    }

    try {
      const tracker = this.#resolver.resolve(project);
      const page = await tracker.listAssignedToMe(callback.page);
      await context.answerCallbackQuery();
      await this.#sendPage(context, page, userId, project.id, callback.depth);
    } catch (error) {
      await context.answerCallbackQuery({ text: "Unable to read this issue page.", show_alert: true });
      if (error instanceof IssueTrackerError && error.code === "NOT_CONFIGURED") return;
    }
  }

  async #handleAssignedToMe(context: Context, projectId: string, userId: number): Promise<void> {
    try {
      const project = await this.#projects.restoreActiveProject(userId);
      if (project === undefined || project.id !== projectId) {
        await context.reply("Select a project first with /projects.");
        return;
      }
      const tracker = this.#resolver.resolve(project);
      const page = await tracker.listAssignedToMe();
      await this.#sendPage(context, page, userId, project.id, 0);
    } catch (error) {
      await context.reply(issueErrorMessage(error));
    }
  }

  async #sendPage(
    context: Context,
    page: IssuePage,
    userId: number,
    projectId: string,
    depth: number,
  ): Promise<void> {
    const keyboard = new InlineKeyboard();
    let buttons = 0;
    if (page.previousPage !== undefined && depth > 0) {
      keyboard.text("Previous", this.#storeCallback(userId, projectId, page.previousPage, depth - 1));
      buttons += 1;
    }
    if (page.nextPage !== undefined && depth < this.#maxPageDepth) {
      keyboard.text("Next", this.#storeCallback(userId, projectId, page.nextPage, depth + 1));
      buttons += 1;
    }
    const message = formatIssuePage(page);
    if (buttons === 0) await context.reply(message);
    else await context.reply(message, { reply_markup: keyboard });
  }

  #storeCallback(userId: number, projectId: string, page: PageToken, depth: number): string {
    this.#pruneCallbacks();
    if (depth > this.#maxPageDepth) throw new Error("Issue page depth exceeds configured maximum");
    const data = `${CALLBACK_PREFIX}${this.#idFactory()}`;
    if (!CALLBACK_PATTERN.test(data)) throw new Error("Issue page callback identifier is invalid");
    if (this.#callbacks.size >= MAX_CALLBACKS) {
      const oldest = this.#callbacks.keys().next().value;
      if (oldest !== undefined) this.#callbacks.delete(oldest);
    }
    this.#callbacks.set(data, {
      userId,
      projectId,
      provider: "github",
      queryKind: "assigned-to-me",
      page,
      depth,
      expiresAt: this.#clock().valueOf() + this.#callbackTtlMs,
    });
    return data;
  }

  #pruneCallbacks(): void {
    const now = this.#clock().valueOf();
    for (const [key, callback] of this.#callbacks) {
      if (callback.expiresAt <= now) this.#callbacks.delete(key);
    }
  }
}

function readIssueCommandArgument(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const parts = text.trim().split(/\s+/u);
  return parts.length === 2 ? parts[1] : undefined;
}

function readIssueReference(argument: string | undefined): string | undefined {
  const reference = argument;
  if (reference === undefined || reference.length > MAX_REFERENCE_LENGTH || !/^#?\d{1,9}$/u.test(reference)) {
    return undefined;
  }
  const number = Number(reference.replace(/^#/u, ""));
  return Number.isSafeInteger(number) && number > 0 ? `#${String(number)}` : undefined;
}

function issueErrorMessage(error: unknown): string {
  if (!(error instanceof IssueTrackerError)) return "Unable to read the issue.";
  switch (error.code) {
    case "INVALID_REFERENCE": return "Issue reference must be a positive issue number.";
    case "NOT_CONFIGURED": return "Issue tracking is not configured for this project.";
    case "UNSUPPORTED_PROVIDER": return "This issue tracker provider is not supported yet.";
    case "NOT_FOUND": return "Issue not found.";
    case "FORBIDDEN": return "Issue access is not permitted.";
    case "AUTHENTICATION_FAILED": return "Issue tracker authentication failed.";
    case "CREDENTIAL_UNAVAILABLE": return "Issue tracker credentials are unavailable.";
    case "NOT_AN_ISSUE": return "That reference is a pull request, not an issue.";
    case "ISSUE_MOVED": return "That issue has moved.";
    case "ISSUE_GONE": return "That issue is no longer available.";
    case "RATE_LIMITED": return "Issue tracker rate limit reached. Try again later.";
    case "ABORTED":
    case "TIMEOUT":
    case "UNAVAILABLE": return "Issue tracker is temporarily unavailable.";
    case "MALFORMED_RESPONSE":
    case "RESPONSE_TOO_LARGE":
    case "PROVIDER_REJECTED_QUERY": return "Issue tracker returned an invalid response.";
  }
}

function formatIssuePage(page: IssuePage): string {
  if (page.items.length === 0) return "Assigned issues\nNo open issues assigned to you.";
  const lines = ["Assigned issues:"];
  for (const issue of page.items) {
    const title = issue.title.replace(/[\r\n]+/gu, " ");
    const line = `• ${issue.reference} · ${issue.state} · ${title}`;
    if ([...lines, line].join("\n").length > MAX_PAGE_MESSAGE_LENGTH) break;
    lines.push(line);
    if (issue.url !== undefined) lines.push(`  ${issue.url}`);
  }
  if (page.incomplete) lines.push("", "Results may be incomplete.");
  return lines.join("\n").slice(0, MAX_PAGE_MESSAGE_LENGTH);
}
