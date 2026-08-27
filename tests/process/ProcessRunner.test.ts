import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  allowEnvironment,
  ProcessRunner,
  ProcessRunnerError,
} from "../../src/process/ProcessRunner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("ProcessRunner", () => {
  it("passes arguments literally without a shell", async () => {
    const cwd = await createTemporaryDirectory();
    const runner = new ProcessRunner();
    const hostileArgument = "$(printf injected); `printf nope`";

    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", hostileArgument],
      cwd,
      env: {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(hostileArgument);
    expect(result.stderr).toBe("");
  });

  it("streams stdout and stderr while returning a non-zero exit code", async () => {
    const cwd = await createTemporaryDirectory();
    const runner = new ProcessRunner();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runner.run({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)",
      ],
      cwd,
      env: {},
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    });

    expect(result.exitCode).toBe(7);
    expect(stdout.join("")).toBe("out");
    expect(stderr.join("")).toBe("err");
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("passes stdin explicitly", async () => {
    const cwd = await createTemporaryDirectory();
    const runner = new ProcessRunner();

    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      cwd,
      env: {},
      stdin: "telegram prompt",
    });

    expect(result.stdout).toBe("telegram prompt");
  });

  it("terminates a timed-out process", async () => {
    const cwd = await createTemporaryDirectory();
    const runner = new ProcessRunner();

    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1_000)"],
      cwd,
      env: {},
      timeoutMs: 50,
      killGraceMs: 50,
    });

    expect(result.terminationReason).toBe("timed_out");
    expect(result.signal).toBe("SIGTERM");
  });

  it("aborts the complete process group", async () => {
    const cwd = await createTemporaryDirectory();
    const marker = join(cwd, "child-survived.txt");
    const runner = new ProcessRunner();
    const controller = new AbortController();
    const childScript = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e',",
      `  ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 350)`)},`,
      "], { stdio: 'ignore' });",
      "setInterval(() => undefined, 1_000);",
    ].join("\n");

    const running = runner.run({
      executable: process.execPath,
      args: ["-e", childScript],
      cwd,
      env: {},
      signal: controller.signal,
      killGraceMs: 50,
    });

    setTimeout(() => controller.abort(), 50);
    const result = await running;
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(result.terminationReason).toBe("aborted");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds captured output without limiting streamed chunks", async () => {
    const cwd = await createTemporaryDirectory();
    const runner = new ProcessRunner();
    const chunks: string[] = [];

    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('1234567890')"],
      cwd,
      env: {},
      maxOutputBytes: 5,
      onStdout: (chunk) => chunks.push(chunk),
    });

    expect(result.stdout).toBe("12345");
    expect(result.stdoutTruncated).toBe(true);
    expect(chunks.join("")).toBe("1234567890");
  });

  it("rejects unsafe request shapes before spawning", () => {
    const runner = new ProcessRunner();

    expect(() =>
      runner.run({ executable: "node", cwd: ".", env: {} }),
    ).toThrow(ProcessRunnerError);
    expect(() =>
      runner.run({ executable: "node", cwd: "/tmp", env: {}, timeoutMs: 0 }),
    ).toThrow(ProcessRunnerError);
  });
});

describe("allowEnvironment", () => {
  it("copies only named, defined variables", () => {
    const result = allowEnvironment(
      { PATH: "/bin", SECRET: "hidden", EMPTY: "" },
      ["PATH", "EMPTY", "MISSING"],
    );

    expect(result).toEqual({ PATH: "/bin", EMPTY: "" });
    expect(result).not.toHaveProperty("SECRET");
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "codex-remote-process-test-"));
  temporaryDirectories.push(path);
  return path;
}
