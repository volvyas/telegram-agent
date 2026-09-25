import { randomUUID } from "node:crypto";
import type { ThreadEvent } from "@openai/codex-sdk";

import type {
  AgentCommandEvent,
  AgentEvent,
  AgentEventBase,
} from "../AgentEvent.js";

const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_TYPE_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 16_384;
const MAX_COMMAND_LENGTH = 2_048;
const MAX_PATH_LENGTH = 1_024;
const MAX_CHANGED_PATHS = 200;

export interface CodexEventMapperOptions {
  readonly runId: string;
  readonly projectId: string;
  readonly clock?: () => Date;
}

export interface CodexDiagnostic {
  readonly kind: "unknown_event" | "malformed_event" | "unknown_item";
  readonly sourceType: string;
}

export class CodexEventMapper {
  readonly #runId: string;
  readonly #projectId: string;
  readonly #clock: () => Date;
  readonly #diagnostics: CodexDiagnostic[] = [];
  #lastAgentMessage: string | undefined;

  public constructor(options: CodexEventMapperOptions) {
    this.#runId = options.runId;
    this.#projectId = options.projectId;
    this.#clock = options.clock ?? (() => new Date());
  }

  public get diagnostics(): readonly CodexDiagnostic[] {
    return Object.freeze([...this.#diagnostics]);
  }

  public map(event: ThreadEvent): readonly AgentEvent[] {
    return this.mapUnknown(event);
  }

  public mapUnknown(event: unknown): readonly AgentEvent[] {
    if (!isRecord(event) || typeof event.type !== "string") {
      this.#recordDiagnostic("malformed_event", "missing");
      return [];
    }

    switch (event.type) {
      case "thread.started":
        return this.#mapThreadStarted(event);
      case "turn.started":
        return [this.#event({ type: "run_started" })];
      case "turn.completed": {
        const question = decodeQuestionOutcome(this.#lastAgentMessage);
        if (question !== undefined) {
          return [this.#event({ type: "question", ...question })];
        }
        return [
          this.#event({
            type: "completed",
            summary: this.#lastAgentMessage ?? "Codex turn completed.",
          }),
        ];
      }
      case "turn.failed":
        return [
          this.#event({
            type: "error",
            fatal: true,
            message: readErrorMessage(event.error, "Codex turn failed"),
          }),
        ];
      case "error":
        return [
          this.#event({
            type: "error",
            fatal: true,
            message: boundedString(event.message, "Codex stream failed", MAX_MESSAGE_LENGTH),
          }),
        ];
      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.#mapItemEvent(event.type, event.item);
      default:
        this.#recordDiagnostic("unknown_event", event.type);
        return [];
    }
  }

  #mapThreadStarted(event: Record<string, unknown>): readonly AgentEvent[] {
    if (typeof event.thread_id !== "string" || event.thread_id.length === 0) {
      this.#recordDiagnostic("malformed_event", "thread.started");
      return [];
    }
    return [this.#event({ type: "thread_started", threadId: event.thread_id })];
  }

  #mapItemEvent(
    eventType: "item.started" | "item.updated" | "item.completed",
    item: unknown,
  ): readonly AgentEvent[] {
    if (!isRecord(item) || typeof item.type !== "string") {
      this.#recordDiagnostic("malformed_event", eventType);
      return [];
    }

    switch (item.type) {
      case "agent_message":
        return this.#mapAgentMessage(eventType, item);
      case "reasoning":
        return [];
      case "command_execution":
        return this.#mapCommand(item);
      case "file_change":
        return eventType === "item.completed" ? this.#mapFileChange(item) : [];
      case "todo_list":
        return this.#mapTodoList(item);
      case "mcp_tool_call":
        return this.#mapMcpToolCall(item);
      case "web_search":
        return this.#mapWebSearch(item);
      case "error":
        return [
          this.#event({
            type: "error",
            fatal: false,
            message: boundedString(item.message, "Codex reported an error", MAX_MESSAGE_LENGTH),
          }),
        ];
      default:
        this.#recordDiagnostic("unknown_item", item.type);
        return [];
    }
  }

  #mapAgentMessage(
    eventType: "item.started" | "item.updated" | "item.completed",
    item: Record<string, unknown>,
  ): readonly AgentEvent[] {
    if (eventType !== "item.completed" || typeof item.text !== "string") {
      return [];
    }

    const message = boundedString(item.text, "Codex produced an empty response", MAX_MESSAGE_LENGTH);
    this.#lastAgentMessage = message;
    // Structured control envelopes are consumed at turn.completed. They are
    // protocol data, not user-facing progress, so never forward them to the
    // Telegram progress reporter.
    if (decodeQuestionOutcome(message) !== undefined) return [];
    return [this.#event({ type: "progress", message, stage: "agent_message" })];
  }

  #mapCommand(item: Record<string, unknown>): readonly AgentEvent[] {
    if (typeof item.command !== "string" || !isCommandStatus(item.status)) {
      this.#recordDiagnostic("malformed_event", "command_execution");
      return [];
    }

    const status: AgentCommandEvent["status"] =
      item.status === "in_progress"
        ? "running"
        : item.status === "completed"
          ? "completed"
          : "failed";
    const base = {
      type: "command" as const,
      command: boundedString(item.command, "command", MAX_COMMAND_LENGTH),
      status,
    };
    return [
      this.#event(
        typeof item.exit_code === "number" && Number.isSafeInteger(item.exit_code)
          ? { ...base, exitCode: item.exit_code }
          : base,
      ),
    ];
  }

  #mapFileChange(item: Record<string, unknown>): readonly AgentEvent[] {
    if (!Array.isArray(item.changes)) {
      this.#recordDiagnostic("malformed_event", "file_change");
      return [];
    }

    const paths = item.changes
      .slice(0, MAX_CHANGED_PATHS)
      .flatMap((change): string[] => {
        if (!isRecord(change) || typeof change.path !== "string") {
          return [];
        }
        return [boundedString(change.path, "unknown", MAX_PATH_LENGTH)];
      });

    return paths.length === 0
      ? []
      : [this.#event({ type: "files_changed", paths: Object.freeze(paths) })];
  }

  #mapTodoList(item: Record<string, unknown>): readonly AgentEvent[] {
    if (!Array.isArray(item.items)) {
      this.#recordDiagnostic("malformed_event", "todo_list");
      return [];
    }
    const completed = item.items.filter(
      (todo) => isRecord(todo) && todo.completed === true,
    ).length;
    return [
      this.#event({
        type: "progress",
        stage: "plan",
        message: `Plan progress: ${String(completed)}/${String(item.items.length)}`,
      }),
    ];
  }

  #mapMcpToolCall(item: Record<string, unknown>): readonly AgentEvent[] {
    if (
      typeof item.server !== "string" ||
      typeof item.tool !== "string" ||
      !isToolStatus(item.status)
    ) {
      this.#recordDiagnostic("malformed_event", "mcp_tool_call");
      return [];
    }

    const toolName = boundedString(`${item.server}.${item.tool}`, "MCP tool", 256);
    if (item.status === "failed") {
      return [
        this.#event({
          type: "warning",
          message: `MCP tool failed: ${toolName}`,
        }),
      ];
    }
    return [
      this.#event({
        type: "progress",
        stage: "mcp",
        message: `MCP tool ${item.status === "completed" ? "completed" : "running"}: ${toolName}`,
      }),
    ];
  }

  #mapWebSearch(item: Record<string, unknown>): readonly AgentEvent[] {
    if (typeof item.query !== "string") {
      this.#recordDiagnostic("malformed_event", "web_search");
      return [];
    }
    return [
      this.#event({
        type: "progress",
        stage: "web_search",
        message: `Web search: ${boundedString(item.query, "query", 512)}`,
      }),
    ];
  }

  #event<T extends Omit<AgentEvent, keyof AgentEventBase>>(
    event: T,
  ): T & AgentEventBase {
    return {
      ...event,
      runId: this.#runId,
      projectId: this.#projectId,
      occurredAt: this.#clock().toISOString(),
    };
  }

  #recordDiagnostic(kind: CodexDiagnostic["kind"], sourceType: string): void {
    if (this.#diagnostics.length >= MAX_DIAGNOSTICS) {
      return;
    }
    this.#diagnostics.push(
      Object.freeze({
        kind,
        sourceType: boundedString(sourceType, "unknown", MAX_DIAGNOSTIC_TYPE_LENGTH),
      }),
    );
  }
}

/**
 * Codex SDK 0.150 does not expose an input-request event.  A turn can instead
 * deliberately finish with this small structured outcome in its final message.
 */
function decodeQuestionOutcome(message: string | undefined): {
  readonly questionId: string;
  readonly question: string;
  readonly choices: readonly string[];
} | undefined {
  if (message === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(message) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    (value.kind !== "question" && value.kind !== "request_for_input" && value.kind !== "request-for-input") ||
    typeof value.question !== "string"
  ) {
    return undefined;
  }
  const question = boundedString(value.question, "", MAX_MESSAGE_LENGTH).trim();
  if (question.length === 0) return undefined;
  if (value.choices !== undefined && !Array.isArray(value.choices)) return undefined;
  const choices = (value.choices ?? []).flatMap((choice): string[] =>
    typeof choice === "string" && choice.trim().length > 0
      ? [boundedString(choice, "", MAX_MESSAGE_LENGTH).trim()]
      : [],
  );
  if (choices.length !== (value.choices?.length ?? 0)) return undefined;
  return Object.freeze({
    questionId: typeof value.questionId === "string" && value.questionId.length > 0
      ? boundedString(value.questionId, "", 128)
      : randomUUID(),
    question,
    choices: Object.freeze(choices),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCommandStatus(value: unknown): value is "in_progress" | "completed" | "failed" {
  return value === "in_progress" || value === "completed" || value === "failed";
}

function isToolStatus(value: unknown): value is "in_progress" | "completed" | "failed" {
  return isCommandStatus(value);
}

function readErrorMessage(value: unknown, fallback: string): string {
  return isRecord(value)
    ? boundedString(value.message, fallback, MAX_MESSAGE_LENGTH)
    : fallback;
}

function boundedString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
