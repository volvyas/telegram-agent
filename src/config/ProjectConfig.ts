import type { IssueTrackerConfig } from "./IssueTrackerConfig.js";

export const ALLOWED_OPERATIONS = [
  "task",
  "status",
  "git",
  "diff",
  "test",
  "build",
  "run",
  "stop",
  "commit",
] as const;

export type AllowedOperation = (typeof ALLOWED_OPERATIONS)[number];

export interface ProjectCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface ProjectConfig {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** Optional project-specific Codex profile; otherwise the app default is used. */
  readonly codexHome?: string;
  readonly allowedOperations: ReadonlySet<AllowedOperation>;
  readonly testCommand?: ProjectCommand;
  readonly buildCommand?: ProjectCommand;
  readonly runCommand?: ProjectCommand;
  readonly branch?: string;
  readonly issueTracker?: IssueTrackerConfig;
}

export class ProjectConfigError extends Error {
  public readonly code: string;
  public readonly projectId?: string;

  public constructor(
    code: string,
    message: string,
    options?: ErrorOptions & { readonly projectId?: string },
  ) {
    super(message, options);
    this.name = "ProjectConfigError";
    this.code = code;
    if (options?.projectId !== undefined) {
      this.projectId = options.projectId;
    }
  }
}
