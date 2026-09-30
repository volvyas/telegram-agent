import { describe, expect, it } from "vitest";

import { ProgressReporter, type ProgressTransport } from "../../src/telegram/ProgressReporter.js";
import type { AgentEvent } from "../../src/agent/AgentEvent.js";

describe("ProgressReporter", () => {
  it("batches transient events into one rate-limited edit", async () => {
    const clock = fakeClock();
    const transport = recordingTransport();
    const reporter = new ProgressReporter({
      now: () => clock.now,
      minUpdateIntervalMs: 1_000,
      setTimer: (callback, delay) => clock.set(callback, delay),
      clearTimer: (timer) => clock.clear(timer),
    });
    await reporter.start("api", transport, "Task started for API.");

    reporter.onEvent(event("progress", { message: "Inspecting files" }));
    reporter.onEvent(event("command", { command: "npm test", status: "running" }));
    reporter.onEvent(event("files_changed", { paths: ["src/a.ts"] }));
    expect(transport.edits).toEqual([]);

    await clock.advance(1_000);

    expect(transport.edits).toHaveLength(1);
    expect(transport.edits[0]).toContain("Inspecting files");
    expect(transport.edits[0]).toContain("Running: npm test");
    expect(transport.edits[0]).toContain("Changed 1 file(s).");
  });

  it("does not turn terminal events into status edits", async () => {
    const transport = recordingTransport();
    const reporter = new ProgressReporter({ minUpdateIntervalMs: 0 });
    await reporter.start("api", transport, "Task started for API.");

    reporter.onEvent(event("completed", { summary: "Done" }));
    reporter.onEvent(event("question", { questionId: "q", question: "Continue?", choices: [] }));
    await reporter.flush("api");

    expect(transport.sent).toEqual(["Task started for API."]);
    expect(transport.edits).toEqual([]);
  });
});

function recordingTransport(): ProgressTransport & { readonly sent: string[]; readonly edits: string[] } {
  const sent: string[] = [];
  const edits: string[] = [];
  return {
    sent,
    edits,
    send(text) { sent.push(text); return Promise.resolve({ messageId: 1 }); },
    edit(_message, text) { edits.push(text); return Promise.resolve(); },
  };
}

function event(type: AgentEvent["type"], fields: Record<string, unknown>): AgentEvent {
  return { type, projectId: "api", runId: "run", occurredAt: "2026-09-15T00:00:00.000Z", ...fields } as AgentEvent;
}

function fakeClock(): {
  now: number;
  set(callback: () => void, delay: number): number;
  clear(timer: unknown): void;
  advance(milliseconds: number): Promise<void>;
} {
  let nextId = 1;
  const timers = new Map<number, { readonly due: number; readonly callback: () => void }>();
  return {
    now: 0,
    set(callback, delay) {
      const id = nextId++;
      timers.set(id, { due: this.now + delay, callback });
      return id;
    },
    clear(timer) { timers.delete(timer as number); },
    async advance(milliseconds) {
      this.now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= this.now) {
          timers.delete(id);
          timer.callback();
        }
      }
      await Promise.resolve();
    },
  };
}
