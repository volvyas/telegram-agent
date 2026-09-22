import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentManager, type AgentProjectRegistry } from "../../src/agent/AgentManager.js";
import type { CodingAgent } from "../../src/agent/CodingAgent.js";
import type { ProjectConfig } from "../../src/config/ProjectConfig.js";
import { ProjectCommandRunner } from "../../src/process/ProjectCommandRunner.js";
import { CLEAN_GIT_STATUS_READER } from "../helpers/GitStatusReader.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ProjectCommandRunner cancellation", () => {
  it("stops the complete test process tree through the project coordinator", async () => {
    const cwd = await temporaryDirectory();
    const marker = join(cwd, "child-survived.txt");
    const childScript = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e',",
      `  ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 300)`)},`,
      "], { stdio: 'ignore' });",
      "setInterval(() => undefined, 1000);",
    ].join("\n");
    const project: ProjectConfig = {
      id: "api", name: "API", path: cwd,
      allowedOperations: new Set(["test", "stop"]),
      testCommand: { executable: process.execPath, args: ["-e", childScript] },
    };
    const commands = new ProjectCommandRunner(undefined, { killGraceMs: 30 });
    const manager = new AgentManager(noAgent(), registry(project), {
      gitService: CLEAN_GIT_STATUS_READER,
    });

    const running = manager.runExclusive(
      project.id,
      "test",
      (signal) => commands.run(project, "test", { signal }),
    );
    await vi.waitFor(() => expect(commands.isRunning(project.id)).toBe(true));

    await expect(manager.stop(project.id)).resolves.toBe(true);
    await expect(running).resolves.toMatchObject({ terminationReason: "aborted" });
    await new Promise((resolve) => setTimeout(resolve, 400));

    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.getStatus(project.id)).toMatchObject({ active: false, state: "IDLE" });
  });
});

function noAgent(): CodingAgent {
  return {
    start: vi.fn(), resume: vi.fn(), send: vi.fn(), stop: vi.fn(() => Promise.resolve(false)),
  };
}

function registry(project: ProjectConfig): AgentProjectRegistry {
  return { require: (id) => {
    if (id !== project.id) throw new Error("Project not found");
    return project;
  } };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "telegram-agent-stop-test-"));
  directories.push(path);
  return path;
}
