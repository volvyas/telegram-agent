import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  ALLOWED_OPERATIONS,
  ProjectConfigError,
  type AllowedOperation,
  type ProjectCommand,
  type ProjectConfig,
} from "../config/ProjectConfig.js";
import {
  allowEnvironment,
  ProcessRunner,
  type ProcessResult,
} from "../process/ProcessRunner.js";

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_PROJECT_NAME_LENGTH = 128;
const MAX_COMMAND_ARGUMENTS = 128;
const MAX_COMMAND_VALUE_LENGTH = 8_192;

export class ProjectManager {
  readonly #projects: ReadonlyMap<string, ProjectConfig>;

  private constructor(projects: ReadonlyMap<string, ProjectConfig>) {
    this.#projects = projects;
  }

  public static async fromDocument(
    document: unknown,
    processRunner = new ProcessRunner(),
  ): Promise<ProjectManager> {
    const rawProjects = readProjectsRecord(document);
    const projects = new Map<string, ProjectConfig>();
    const paths = new Set<string>();

    for (const [id, rawProject] of Object.entries(rawProjects)) {
      validateProjectId(id);
      const candidate = parseProjectCandidate(id, rawProject);
      const canonicalPath = await inspectRepository(id, candidate.path, processRunner);

      if (paths.has(canonicalPath)) {
        throw new ProjectConfigError(
          "PROJECT_PATH_DUPLICATE",
          "Multiple project IDs resolve to the same repository",
          { projectId: id },
        );
      }
      paths.add(canonicalPath);

      projects.set(id, freezeProject({ ...candidate, path: canonicalPath }));
    }

    return new ProjectManager(projects);
  }

  public list(): readonly ProjectConfig[] {
    return Object.freeze(
      [...this.#projects.values()].sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  public get(projectId: string): ProjectConfig | undefined {
    return this.#projects.get(projectId);
  }

  public require(projectId: string): ProjectConfig {
    const project = this.get(projectId);
    if (project === undefined) {
      throw new ProjectConfigError("PROJECT_NOT_FOUND", "Project is not configured", {
        projectId,
      });
    }
    return project;
  }
}

type ProjectCandidate = Omit<ProjectConfig, "path"> & { readonly path: string };

function readProjectsRecord(document: unknown): Record<string, unknown> {
  if (!isRecord(document) || !isRecord(document.projects)) {
    throw new ProjectConfigError(
      "PROJECTS_DOCUMENT_INVALID",
      "Projects configuration must contain a projects object",
    );
  }
  if (Object.keys(document.projects).length === 0) {
    throw new ProjectConfigError(
      "PROJECTS_EMPTY",
      "Projects configuration must contain at least one project",
    );
  }
  return document.projects;
}

function validateProjectId(id: string): void {
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new ProjectConfigError(
      "PROJECT_ID_INVALID",
      "Project ID must be a lowercase bounded slug",
      { projectId: id },
    );
  }
}

function parseProjectCandidate(id: string, value: unknown): ProjectCandidate {
  if (!isRecord(value)) {
    throw invalidProject(id, "Project configuration must be an object");
  }

  const name = readBoundedString(value.name, id, "name", MAX_PROJECT_NAME_LENGTH);
  const path = readBoundedString(value.path, id, "path", MAX_COMMAND_VALUE_LENGTH);
  if (!isAbsolute(path)) {
    throw invalidProject(id, "Project path must be absolute");
  }

  const allowedOperations = parseAllowedOperations(value.allowedOperations, id);
  const testCommand = parseOptionalCommand(value.testCommand, id, "testCommand");
  const buildCommand = parseOptionalCommand(value.buildCommand, id, "buildCommand");
  const runCommand = parseOptionalCommand(value.runCommand, id, "runCommand");
  const branch = parseOptionalString(value.branch, id, "branch", 255);

  return {
    id,
    name,
    path,
    allowedOperations,
    ...(testCommand === undefined ? {} : { testCommand }),
    ...(buildCommand === undefined ? {} : { buildCommand }),
    ...(runCommand === undefined ? {} : { runCommand }),
    ...(branch === undefined ? {} : { branch }),
  };
}

function parseAllowedOperations(value: unknown, projectId: string): ReadonlySet<AllowedOperation> {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidProject(projectId, "allowedOperations must be a non-empty array");
  }

  const operations = new Set<AllowedOperation>();
  for (const item of value) {
    if (typeof item !== "string" || !isAllowedOperation(item)) {
      throw invalidProject(projectId, "allowedOperations contains an unsupported value");
    }
    operations.add(item);
  }
  return operations;
}

function parseOptionalCommand(
  value: unknown,
  projectId: string,
  field: string,
): ProjectCommand | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalidProject(projectId, `${field} must be an object`);
  }

  const executable = readBoundedString(
    value.executable,
    projectId,
    `${field}.executable`,
    MAX_COMMAND_VALUE_LENGTH,
  );
  if (!Array.isArray(value.args) || value.args.length > MAX_COMMAND_ARGUMENTS) {
    throw invalidProject(projectId, `${field}.args must be a bounded string array`);
  }
  const args = value.args.map((argument) => {
    if (
      typeof argument !== "string" ||
      argument.includes("\0") ||
      argument.length > MAX_COMMAND_VALUE_LENGTH
    ) {
      throw invalidProject(projectId, `${field}.args must be a bounded string array`);
    }
    return argument;
  });

  return Object.freeze({ executable, args: Object.freeze(args) });
}

function parseOptionalString(
  value: unknown,
  projectId: string,
  field: string,
  maxLength: number,
): string | undefined {
  return value === undefined
    ? undefined
    : readBoundedString(value, projectId, field, maxLength);
}

function readBoundedString(
  value: unknown,
  projectId: string,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw invalidProject(projectId, `${field} must be a non-empty bounded string`);
  }
  return value.trim();
}

async function inspectRepository(
  projectId: string,
  configuredPath: string,
  processRunner: ProcessRunner,
): Promise<string> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(resolve(configuredPath));
    const projectStat = await stat(canonicalPath);
    if (!projectStat.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    throw new ProjectConfigError(
      "PROJECT_PATH_INVALID",
      "Project path must reference an existing directory",
      { cause: error, projectId },
    );
  }

  let result: ProcessResult;
  try {
    result = await processRunner.run({
      executable: "git",
      args: ["rev-parse", "--show-toplevel"],
      cwd: canonicalPath,
      env: allowEnvironment(process.env, ["PATH", "LANG", "LC_ALL"]),
      timeoutMs: 5_000,
      maxOutputBytes: 16_384,
    });
  } catch (error) {
    throw new ProjectConfigError(
      "PROJECT_GIT_CHECK_FAILED",
      "Unable to verify project Git repository",
      { cause: error, projectId },
    );
  }

  if (result.exitCode !== 0 || result.terminationReason !== undefined) {
    throw new ProjectConfigError(
      "PROJECT_NOT_GIT_REPOSITORY",
      "Project path must be a Git repository root",
      { projectId },
    );
  }

  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(result.stdout.trimEnd());
  } catch (error) {
    throw new ProjectConfigError(
      "PROJECT_GIT_ROOT_INVALID",
      "Git returned an invalid repository root",
      { cause: error, projectId },
    );
  }

  if (repositoryRoot !== canonicalPath) {
    throw new ProjectConfigError(
      "PROJECT_PATH_NOT_GIT_ROOT",
      "Project path must point to the Git repository root",
      { projectId },
    );
  }
  return canonicalPath;
}

function freezeProject(project: ProjectConfig): ProjectConfig {
  return Object.freeze(project);
}

function isAllowedOperation(value: string): value is AllowedOperation {
  return (ALLOWED_OPERATIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidProject(projectId: string, message: string): ProjectConfigError {
  return new ProjectConfigError("PROJECT_INVALID", message, { projectId });
}
