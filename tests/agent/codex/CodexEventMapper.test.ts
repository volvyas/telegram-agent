import type { ThreadEvent } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";

import { CodexEventMapper } from "../../../src/agent/codex/CodexEventMapper.js";

const context = {
  runId: "RUN-1",
  projectId: "motor",
  clock: () => new Date("2026-08-27T10:00:00.000Z"),
};

describe("CodexEventMapper", () => {
  it("maps thread, turn and final agent result events", () => {
    const mapper = new CodexEventMapper(context);

    expect(mapper.map(fixture({ type: "thread.started", thread_id: "THREAD-1" }))).toEqual([
      {
        type: "thread_started",
        threadId: "THREAD-1",
        runId: "RUN-1",
        projectId: "motor",
        occurredAt: "2026-08-27T10:00:00.000Z",
      },
    ]);
    expect(mapper.map(fixture({ type: "turn.started" }))).toEqual([
      expect.objectContaining({ type: "run_started" }),
    ]);
    expect(
      mapper.map(
        fixture({
          type: "item.completed",
          item: { id: "message-1", type: "agent_message", text: "Implemented tests" },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "progress",
        stage: "agent_message",
        message: "Implemented tests",
      }),
    ]);
    expect(
      mapper.map(
        fixture({
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ type: "completed", summary: "Implemented tests" }),
    ]);
  });

  it("maps command lifecycle and completed file changes", () => {
    const mapper = new CodexEventMapper(context);

    expect(
      mapper.map(
        fixture({
          type: "item.started",
          item: {
            id: "command-1",
            type: "command_execution",
            command: "npm test",
            aggregated_output: "",
            status: "in_progress",
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ type: "command", command: "npm test", status: "running" }),
    ]);
    expect(
      mapper.map(
        fixture({
          type: "item.completed",
          item: {
            id: "command-1",
            type: "command_execution",
            command: "npm test",
            aggregated_output: "passed",
            exit_code: 0,
            status: "completed",
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ type: "command", status: "completed", exitCode: 0 }),
    ]);
    expect(
      mapper.map(
        fixture({
          type: "item.completed",
          item: {
            id: "file-1",
            type: "file_change",
            changes: [
              { path: "src/index.ts", kind: "update" },
              { path: "tests/index.test.ts", kind: "add" },
            ],
            status: "completed",
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        type: "files_changed",
        paths: ["src/index.ts", "tests/index.test.ts"],
      }),
    ]);
  });

  it("maps fatal and non-fatal errors", () => {
    const mapper = new CodexEventMapper(context);

    expect(
      mapper.map(fixture({ type: "turn.failed", error: { message: "model failed" } })),
    ).toEqual([expect.objectContaining({ type: "error", fatal: true, message: "model failed" })]);
    expect(
      mapper.map(
        fixture({
          type: "item.completed",
          item: { id: "error-1", type: "error", message: "tool failed" },
        }),
      ),
    ).toEqual([expect.objectContaining({ type: "error", fatal: false, message: "tool failed" })]);
  });

  it("never forwards reasoning text", () => {
    const mapper = new CodexEventMapper(context);

    const events = mapper.map(
      fixture({
        type: "item.completed",
        item: { id: "reasoning-1", type: "reasoning", text: "private reasoning" },
      }),
    );

    expect(events).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("private reasoning");
  });

  it("keeps unknown and malformed payloads only as bounded diagnostics", () => {
    const mapper = new CodexEventMapper(context);
    const secretPayload = "secret-value-that-must-not-be-copied";

    for (let index = 0; index < 30; index += 1) {
      expect(
        mapper.mapUnknown({
          type: `future.event.${String(index)}${"x".repeat(100)}`,
          payload: secretPayload,
        }),
      ).toEqual([]);
    }
    expect(mapper.mapUnknown({ broken: true })).toEqual([]);

    expect(mapper.diagnostics).toHaveLength(20);
    expect(mapper.diagnostics[0]).toMatchObject({ kind: "unknown_event" });
    expect(mapper.diagnostics[0]?.sourceType.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(mapper.diagnostics)).not.toContain(secretPayload);
  });
});

function fixture(event: ThreadEvent): ThreadEvent {
  return event;
}
