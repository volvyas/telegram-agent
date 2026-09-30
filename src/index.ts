import { Application } from "./app/Application.js";
import { StructuredLogger } from "./logging/StructuredLogger.js";

export const APPLICATION_NAME = "codex-remote";

export async function main(): Promise<void> {
  const application = await Application.create();
  await application.start();
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    const fields = error instanceof Error && typeof error === "object"
      ? {
          ...(typeof (error as { readonly code?: unknown }).code === "string"
            ? { code: (error as unknown as { readonly code: string }).code }
            : {}),
          ...(typeof (error as { readonly projectId?: unknown }).projectId === "string"
            ? { projectId: (error as unknown as { readonly projectId: string }).projectId }
            : {}),
        }
      : {};
    new StructuredLogger({ level: "error" }).error("Application failed.", fields);
    process.exitCode = 1;
  });
}
