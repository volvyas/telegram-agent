import type { ThreadEvent } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";

import {
  CodexAdapter,
  CodexAdapterError,
  createCodexEnvironment,
  type CodexClientPort,
  type CodexThreadPort,
  type SafeCodexThreadOptions,
} from "../../../src/agent/codex/CodexAdapter.js";
import type { AgentEvent } from "../../../src/agent/AgentEvent.js";

const completedEvents: readonly ThreadEvent[] = [
  { type: "thread.started", thread_id: "THREAD-1" },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: "Task completed" },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  },
];

describe("CodexAdapter", () => {
  it("starts a streamed turn with locked-down SDK options", async () => {
    const thread = new FakeThread(completedEvents);
    const client = new FakeClient(thread);
    const adapter = createAdapter(client);

    const run = await adapter.start({
      projectId: "motor",
      workingDirectory: "/projects/motor",
      prompt: "Add tests safely",
    });
    const events = await collect(run.events);

    expect(run).toMatchObject({ runId: "RUN-1", projectId: "motor" });
    expect(client.startCalls).toEqual([
      {
        threadSource: "codex-remote",
        workingDirectory: "/projects/motor",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        skipGitRepoCheck: false,
        additionalDirectories: [],
      },
    ]);
    expect(thread.inputs).toEqual(["Add tests safely"]);
    expect(thread.signals[0]).toBeInstanceOf(AbortSignal);
    expect(events).toEqual([
      expect.objectContaining({ type: "thread_started", threadId: "THREAD-1" }),
      expect.objectContaining({ type: "run_started" }),
      expect.objectContaining({ type: "progress", message: "Task completed" }),
      expect.objectContaining({ type: "completed", summary: "Task completed" }),
    ]);
    expect(adapter.getThreadId("motor")).toBe("THREAD-1");
  });

  it("propagates the resolved model while retaining locked-down thread options", async () => {
    const thread = new FakeThread(completedEvents);
    const client = new FakeClient(thread);
    const adapter = new CodexAdapter({
      client,
      provider: {
        providerId: "local",
        model: "qwen-coder",
        config: { model_provider: "local" },
      },
    });

    const run = await adapter.start({
      projectId: "motor",
      workingDirectory: "/projects/motor",
      prompt: "Run",
    });
    await collect(run.events);

    expect(client.startCalls[0]).toMatchObject({
      model: "qwen-coder",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });
  });

  it("treats a structured question as the terminal outcome of the stream", async () => {
    const thread = new FakeThread([
      { type: "thread.started", thread_id: "THREAD-1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "message-question",
          type: "agent_message",
          text: JSON.stringify({ kind: "question", question: "Which option?", choices: ["A", "B"] }),
        },
      },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ]);
    const adapter = createAdapter(new FakeClient(thread));

    const run = await adapter.start({
      projectId: "motor",
      workingDirectory: "/projects/motor",
      prompt: "Ask me",
    });

    await expect(collect(run.events)).resolves.toEqual([
      expect.objectContaining({ type: "thread_started" }),
      expect.objectContaining({ type: "run_started" }),
      expect.objectContaining({ type: "question", question: "Which option?", choices: ["A", "B"] }),
    ]);
  });

  it("resumes and sends messages to the requested persisted thread", async () => {
    const resumedEvents = completedEvents.map((event) =>
      event.type === "thread.started"
        ? { ...event, thread_id: "THREAD-OLD" }
        : event,
    );
    const thread = new FakeThread(resumedEvents, "THREAD-DECOY");
    const client = new FakeClient(thread);
    const adapter = createAdapter(client);

    const resumed = await adapter.resume({
      projectId: "motor",
      workingDirectory: "/projects/motor",
      threadId: "THREAD-OLD",
      prompt: "Continue",
    });
    expect(adapter.getThreadId("motor")).toBeUndefined();
    await collect(resumed.events);
    const answer = await adapter.send({
      projectId: "motor",
      workingDirectory: "/projects/motor",
      threadId: "THREAD-OLD",
      message: "Use existing JWT",
    });
    await collect(answer.events);

    expect(client.startCalls).toEqual([]);
    expect(client.resumeCalls).toEqual([
      {
        threadId: "THREAD-OLD",
        options: {
          threadSource: "codex-remote",
          workingDirectory: "/projects/motor",
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          networkAccessEnabled: false,
          webSearchMode: "disabled",
          skipGitRepoCheck: false,
          additionalDirectories: [],
        },
      },
      {
        threadId: "THREAD-OLD",
        options: {
          threadSource: "codex-remote",
          workingDirectory: "/projects/motor",
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          networkAccessEnabled: false,
          webSearchMode: "disabled",
          skipGitRepoCheck: false,
          additionalDirectories: [],
        },
      },
    ]);
    expect(thread.inputs).toEqual(["Continue", "Use existing JWT"]);
    expect(adapter.getThreadId("motor")).toBe("THREAD-OLD");
  });

  it("rejects a structured thread ID that differs from the requested resume ID", async () => {
    const adapter = createAdapter(new FakeClient(new FakeThread(completedEvents)));
    const run = await adapter.resume({
      projectId: "motor",
      workingDirectory: "/projects/motor",
      threadId: "THREAD-OLD",
      prompt: "Continue",
    });

    await expect(collect(run.events)).resolves.toEqual([
      expect.objectContaining({
        type: "error",
        fatal: true,
        message: "Codex event stream ended unexpectedly",
      }),
    ]);
    expect(adapter.getThreadId("motor")).toBeUndefined();
  });

  it("aborts an active SDK stream and emits one stopped event", async () => {
    const started = deferred<boolean>();
    const thread = new BlockingFakeThread(() => started.resolve(true));
    const client = new FakeClient(thread);
    const adapter = createAdapter(client);
    const run = await adapter.start({
      projectId: "motor",
      workingDirectory: "/projects/motor",
      prompt: "Long task",
    });

    const collecting = collect(run.events);
    await started.promise;
    await expect(adapter.stop(run.runId)).resolves.toBe(true);
    await expect(adapter.stop(run.runId)).resolves.toBe(false);
    const events = await collecting;

    expect(events).toEqual([
      expect.objectContaining({ type: "run_started" }),
      expect.objectContaining({ type: "stopped", runId: "RUN-1", reason: "user" }),
    ]);
  });

  it("emits stopped promptly even when the SDK iterator ignores abort", async () => {
    const started = deferred<boolean>();
    const adapter = createAdapter(new FakeClient(new IgnoringAbortFakeThread(
      () => started.resolve(true),
    )));
    const run = await adapter.start({
      projectId: "motor",
      workingDirectory: "/projects/motor",
      prompt: "Long task",
    });
    const collecting = collect(run.events);
    await started.promise;

    await adapter.stop(run.runId);

    await expect(collecting).resolves.toEqual([
      expect.objectContaining({ type: "run_started" }),
      expect.objectContaining({ type: "stopped", reason: "user" }),
    ]);
  });

  it("turns an unexpected stream failure into a safe fatal event", async () => {
    const secret = "sensitive-stream-details";
    const thread = new FailingStreamFakeThread(secret);
    const adapter = createAdapter(new FakeClient(thread));
    const run = await adapter.start({
      projectId: "motor",
      workingDirectory: "/projects/motor",
      prompt: "Run",
    });

    const events = await collect(run.events);

    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        fatal: true,
        message: "Codex event stream ended unexpectedly",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("rejects SDK startup failure without exposing its cause", async () => {
    const thread = new StartFailingFakeThread("secret startup details");
    const adapter = createAdapter(new FakeClient(thread));

    const starting = adapter.start({
      projectId: "motor",
      workingDirectory: "/projects/motor",
      prompt: "Run",
    });

    await expect(starting).rejects.toMatchObject({
      code: "CODEX_START_FAILED",
      message: "Unable to start Codex turn",
    });
    await expect(starting).rejects.not.toThrow("secret startup details");
  });

  it("wraps synchronous SDK thread creation failures safely", () => {
    const adapter = createAdapter(new ThrowingFakeClient("private SDK details"));

    expect(() =>
      adapter.start({
        projectId: "motor",
        workingDirectory: "/projects/motor",
        prompt: "Run",
      }),
    ).toThrow("Unable to create Codex thread");
    expect(() =>
      adapter.start({
        projectId: "motor",
        workingDirectory: "/projects/motor",
        prompt: "Run",
      }),
    ).not.toThrow("private SDK details");
  });

  it("validates inputs before calling the SDK", () => {
    const client = new FakeClient(new FakeThread(completedEvents));
    const adapter = createAdapter(client);

    expect(() =>
      adapter.start({ projectId: "motor", workingDirectory: "relative", prompt: "Run" }),
    ).toThrow(CodexAdapterError);
    expect(() =>
      adapter.resume({
        projectId: "motor",
        workingDirectory: "/projects/motor",
        threadId: "",
        prompt: "Run",
      }),
    ).toThrow(CodexAdapterError);
    expect(client.startCalls).toHaveLength(0);
    expect(client.resumeCalls).toHaveLength(0);
  });
});

describe("createCodexEnvironment", () => {
  it("uses an allowlist and an explicit absolute CODEX_HOME", () => {
    const environment = createCodexEnvironment(
      {
        HOME: "/home/user",
        PATH: "/usr/bin",
        LANG: "uk_UA.UTF-8",
        SECRET_VALUE: "must-not-pass",
        CODEX_HOME: "/wrong/home",
      },
      "/var/lib/codex-remote/codex-home",
    );

    expect(environment).toEqual({
      HOME: "/home/user",
      PATH: "/usr/bin",
      LANG: "uk_UA.UTF-8",
      CODEX_HOME: "/var/lib/codex-remote/codex-home",
    });
    expect(environment).not.toHaveProperty("SECRET_VALUE");
  });

  it("adds only the referenced provider credential to the child environment", () => {
    const environment = createCodexEnvironment(
      { PATH: "/usr/bin", OTHER_SECRET: "must-not-pass" },
      undefined,
      { environmentName: "LOCAL_MODEL_KEY", value: "model-secret" },
    );

    expect(environment).toMatchObject({ PATH: "/usr/bin", LOCAL_MODEL_KEY: "model-secret" });
    expect(environment).not.toHaveProperty("OTHER_SECRET");
  });

  it("rejects a relative CODEX_HOME without echoing it", () => {
    expect(() => createCodexEnvironment({}, "private/codex-home")).toThrow(
      "CODEX_HOME must be absolute",
    );
    expect(() => createCodexEnvironment({}, "private/codex-home")).not.toThrow(
      "private/codex-home",
    );
  });
});

function createAdapter(client: CodexClientPort): CodexAdapter {
  return new CodexAdapter({
    client,
    idFactory: () => "RUN-1",
    clock: () => new Date("2026-08-27T10:00:00.000Z"),
  });
}

class FakeClient implements CodexClientPort {
  public readonly startCalls: SafeCodexThreadOptions[] = [];
  public readonly resumeCalls: {
    readonly threadId: string;
    readonly options: SafeCodexThreadOptions;
  }[] = [];
  readonly #thread: CodexThreadPort;

  public constructor(thread: CodexThreadPort) {
    this.#thread = thread;
  }

  public startThread(options: SafeCodexThreadOptions): CodexThreadPort {
    this.startCalls.push(options);
    return this.#thread;
  }

  public resumeThread(
    threadId: string,
    options: SafeCodexThreadOptions,
  ): CodexThreadPort {
    this.resumeCalls.push({ threadId, options });
    return this.#thread;
  }
}

class ThrowingFakeClient implements CodexClientPort {
  readonly #message: string;

  public constructor(message: string) {
    this.#message = message;
  }

  public startThread(): CodexThreadPort {
    throw new Error(this.#message);
  }

  public resumeThread(): CodexThreadPort {
    throw new Error(this.#message);
  }
}

class FakeThread implements CodexThreadPort {
  public readonly id: string | null;
  public readonly inputs: string[] = [];
  public readonly signals: AbortSignal[] = [];
  readonly #events: readonly ThreadEvent[];

  public constructor(events: readonly ThreadEvent[], id: string | null = null) {
    this.#events = events;
    this.id = id;
  }

  public runStreamed(
    input: string,
    options: { readonly signal: AbortSignal },
  ): Promise<{ readonly events: AsyncIterable<ThreadEvent> }> {
    this.inputs.push(input);
    this.signals.push(options.signal);
    return Promise.resolve({ events: eventsFrom(this.#events) });
  }
}

class BlockingFakeThread implements CodexThreadPort {
  public readonly id: string | null = null;
  readonly #onStarted: () => void;

  public constructor(onStarted: () => void) {
    this.#onStarted = onStarted;
  }

  public runStreamed(
    _input: string,
    options: { readonly signal: AbortSignal },
  ): Promise<{ readonly events: AsyncIterable<ThreadEvent> }> {
    const onStarted = this.#onStarted;
    return Promise.resolve({
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "turn.started" } as const;
          onStarted();
          await rejectWhenAborted(options.signal);
        },
      },
    });
  }
}

class IgnoringAbortFakeThread implements CodexThreadPort {
  public readonly id: string | null = null;
  readonly #onStarted: () => void;

  public constructor(onStarted: () => void) {
    this.#onStarted = onStarted;
  }

  public runStreamed(): Promise<{ readonly events: AsyncIterable<ThreadEvent> }> {
    const onStarted = this.#onStarted;
    return Promise.resolve({
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "turn.started" } as const;
          onStarted();
          await new Promise<never>(() => undefined);
        },
      },
    });
  }
}

class FailingStreamFakeThread implements CodexThreadPort {
  public readonly id: string | null = null;
  readonly #message: string;

  public constructor(message: string) {
    this.#message = message;
  }

  public runStreamed(): Promise<{ readonly events: AsyncIterable<ThreadEvent> }> {
    const message = this.#message;
    return Promise.resolve({
      events: {
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.reject(new Error(message)),
          };
        },
      },
    });
  }
}

class StartFailingFakeThread implements CodexThreadPort {
  public readonly id: string | null = null;
  readonly #message: string;

  public constructor(message: string) {
    this.#message = message;
  }

  public runStreamed(): Promise<{ readonly events: AsyncIterable<ThreadEvent> }> {
    return Promise.reject(new Error(this.#message));
  }
}

async function* eventsFrom(events: readonly ThreadEvent[]): AsyncIterable<ThreadEvent> {
  await Promise.resolve();
  yield* events;
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
