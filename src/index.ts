import { Application } from "./app/Application.js";
import { StructuredLogger } from "./logging/StructuredLogger.js";

export const APPLICATION_NAME = "codex-remote";

export async function main(): Promise<void> {
  const application = await Application.create();
  await application.start();
}

if (import.meta.main) {
  void main().catch(() => {
    new StructuredLogger({ level: "error" }).error("Application failed.");
    process.exitCode = 1;
  });
}
