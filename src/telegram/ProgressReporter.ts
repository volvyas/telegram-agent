import type { AgentEvent } from "../agent/AgentEvent.js";

const DEFAULT_MIN_UPDATE_INTERVAL_MS = 2_500;
const MAX_LINES = 3;
const MAX_MESSAGE_LENGTH = 4_096;

export interface ProgressMessage {
  readonly messageId: number;
}

/** Small transport boundary which makes rate limiting independently testable. */
export interface ProgressTransport {
  send(text: string): Promise<ProgressMessage | undefined>;
  edit(message: ProgressMessage, text: string): Promise<void>;
}

export interface ProgressReporterOptions {
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly minUpdateIntervalMs?: number;
}

interface ActiveProgress {
  readonly transport: ProgressTransport;
  readonly message: ProgressMessage | undefined;
  lines: string[];
  lastEditAt: number;
  timer: unknown;
}

/**
 * Coalesces transient agent activity into edits of one status message. Terminal
 * events are intentionally ignored here: their handler sends a distinct message.
 */
export class ProgressReporter {
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  readonly #minIntervalMs: number;
  readonly #active = new Map<string, ActiveProgress>();

  public constructor(options: ProgressReporterOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.#minIntervalMs = options.minUpdateIntervalMs ?? DEFAULT_MIN_UPDATE_INTERVAL_MS;
    if (!Number.isSafeInteger(this.#minIntervalMs) || this.#minIntervalMs < 0) {
      throw new TypeError("minUpdateIntervalMs must be a non-negative integer");
    }
  }

  public async start(projectId: string, transport: ProgressTransport, initialText: string): Promise<void> {
    this.stop(projectId);
    const message = await transport.send(bound(initialText));
    this.#active.set(projectId, {
      transport,
      message,
      lines: [],
      lastEditAt: this.#now(),
      timer: undefined,
    });
  }

  public onEvent(event: AgentEvent): void {
    if (isTerminal(event)) return;
    const active = this.#active.get(event.projectId);
    const line = formatProgress(event);
    if (active === undefined || line === undefined) return;
    active.lines = [...active.lines, line].slice(-MAX_LINES);
    this.#schedule(event.projectId, active);
  }

  /** Flushes transient progress before a separately delivered terminal event. */
  public async flush(projectId: string): Promise<void> {
    const active = this.#active.get(projectId);
    if (active === undefined || active.lines.length === 0) return;
    if (active.timer !== undefined) {
      this.#clearTimer(active.timer);
      active.timer = undefined;
    }
    await this.#edit(projectId, active);
  }

  public stop(projectId: string): void {
    const active = this.#active.get(projectId);
    if (active?.timer !== undefined) this.#clearTimer(active.timer);
    this.#active.delete(projectId);
  }

  #schedule(projectId: string, active: ActiveProgress): void {
    if (active.message === undefined || active.timer !== undefined) return;
    const delay = Math.max(0, this.#minIntervalMs - (this.#now() - active.lastEditAt));
    active.timer = this.#setTimer(() => {
      active.timer = undefined;
      void this.#edit(projectId, active);
    }, delay);
  }

  async #edit(projectId: string, active: ActiveProgress): Promise<void> {
    if (this.#active.get(projectId) !== active || active.message === undefined || active.lines.length === 0) return;
    const text = bound(["Working…", ...active.lines].join("\n"));
    active.lines = [];
    active.lastEditAt = this.#now();
    try {
      await active.transport.edit(active.message, text);
    } catch {
      // A deleted/unchanged Telegram message must not fail the coding operation.
    }
  }
}

function isTerminal(event: AgentEvent): boolean {
  return event.type === "question" || event.type === "completed" || event.type === "stopped" ||
    (event.type === "error" && event.fatal);
}

function formatProgress(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "progress": return event.message;
    case "command": return event.status === "running" ? `Running: ${event.command}` : `Command ${event.status}: ${event.command}`;
    case "files_changed": return `Changed ${String(event.paths.length)} file(s).`;
    case "warning": return `Warning: ${event.message}`;
    case "run_started": return "Agent is working…";
    default: return undefined;
  }
}

function bound(value: string): string {
  return value.length <= MAX_MESSAGE_LENGTH ? value : `${value.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}
