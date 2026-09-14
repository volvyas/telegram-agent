import { Application } from "./app/Application.js";

export const APPLICATION_NAME = "codex-remote";

export async function main(): Promise<void> {
  const application = await Application.create();
  await application.start();
}

if (import.meta.main) {
  void main().catch(() => {
    console.error("Application failed.");
    process.exitCode = 1;
  });
}
