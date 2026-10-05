import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  ALLOWED_OPERATIONS,
  CODEX_BUILTIN_PROVIDERS,
  ProjectConfigError,
  type AllowedOperation,
  type ModelProviderConfig,
  type ModelProviderMap,
  type ProjectCommand,
  type ProjectConfig,
} from "../config/ProjectConfig.js";
import {
  GITHUB_DEFAULT_API_BASE_URL,
  GITHUB_DEFAULT_PAGE_SIZE,
  GITHUB_ISSUE_TRACKER_LIMITS,
  GITHUB_MAX_PAGE_SIZE,
  type GitHubIssueTrackerConfig,
  type IssueTrackerConfig,
} from "../config/IssueTrackerConfig.js";
import {
  allowEnvironment,
  ProcessRunner,
  type ProcessResult,
} from "../process/ProcessRunner.js";

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_PROJECT_NAME_LENGTH = 128;
const MAX_COMMAND_ARGUMENTS = 128;
const MAX_COMMAND_VALUE_LENGTH = 8_192;
const GITHUB_OWNER_MAX_LENGTH = 100;
const GITHUB_REPOSITORY_MAX_LENGTH = 100;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const API_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MODEL_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_PROVIDER_NAME_LENGTH = 128;
const MAX_PROVIDER_URL_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 256;

export class ProjectManager {
  readonly #projects: ReadonlyMap<string, ProjectConfig>;
  readonly #modelProviders: ModelProviderMap;

  private constructor(
    projects: ReadonlyMap<string, ProjectConfig>,
    modelProviders: ModelProviderMap,
  ) {
    this.#projects = projects;
    this.#modelProviders = modelProviders;
  }

  public static async fromDocument(
    document: unknown,
    processRunner = new ProcessRunner(),
  ): Promise<ProjectManager> {
    const rawProjects = readProjectsRecord(document);
    const modelProviders = parseModelProviders(document);
    const projects = new Map<string, ProjectConfig>();
    const paths = new Set<string>();

    for (const [id, rawProject] of Object.entries(rawProjects)) {
      validateProjectId(id);
      const candidate = parseProjectCandidate(id, rawProject, modelProviders);
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

    return new ProjectManager(projects, modelProviders);
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

  public modelProviders(): ModelProviderMap {
    return new Map(this.#modelProviders);
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

function parseProjectCandidate(
  id: string,
  value: unknown,
  modelProviders: ModelProviderMap,
): ProjectCandidate {
  if (!isRecord(value)) {
    throw invalidProject(id, "Project configuration must be an object");
  }

  const name = readBoundedString(value.name, id, "name", MAX_PROJECT_NAME_LENGTH);
  const path = readBoundedString(value.path, id, "path", MAX_COMMAND_VALUE_LENGTH);
  if (!isAbsolute(path)) {
    throw invalidProject(id, "Project path must be absolute");
  }
  const codexHome = parseOptionalAbsolutePath(value.codexHome, id);
  const agent = parseOptionalAgent(value.agent, id, modelProviders);

  const allowedOperations = parseAllowedOperations(value.allowedOperations, id);
  const testCommand = parseOptionalCommand(value.testCommand, id, "testCommand");
  const buildCommand = parseOptionalCommand(value.buildCommand, id, "buildCommand");
  const runCommand = parseOptionalCommand(value.runCommand, id, "runCommand");
  const branch = parseOptionalString(value.branch, id, "branch", 255);
  const issueTracker = parseOptionalIssueTracker(value.issueTracker, id);

  return {
    id,
    name,
    path,
    ...(codexHome === undefined ? {} : { codexHome }),
    ...(agent === undefined ? {} : { agent }),
    allowedOperations,
    ...(testCommand === undefined ? {} : { testCommand }),
    ...(buildCommand === undefined ? {} : { buildCommand }),
    ...(runCommand === undefined ? {} : { runCommand }),
    ...(branch === undefined ? {} : { branch }),
    ...(issueTracker === undefined ? {} : { issueTracker }),
  };
}

function parseModelProviders(document: unknown): ModelProviderMap {
  if (!isRecord(document)) return new Map();
  if (document.modelProviders === undefined) return new Map();
  if (!isRecord(document.modelProviders)) {
    throw new ProjectConfigError(
      "MODEL_PROVIDERS_INVALID",
      "modelProviders must be an object",
    );
  }

  const providers = new Map<string, ModelProviderConfig>();
  for (const [id, value] of Object.entries(document.modelProviders)) {
    if (!MODEL_PROVIDER_ID_PATTERN.test(id)) {
      throw new ProjectConfigError(
        "MODEL_PROVIDER_ID_INVALID",
        "Model provider ID must be a lowercase bounded slug",
      );
    }
    if (providers.has(id)) {
      throw new ProjectConfigError(
        "MODEL_PROVIDER_DUPLICATE",
        "Model provider ID is duplicated",
      );
    }
    providers.set(id, parseModelProvider(id, value));
  }
  return providers;
}

function parseModelProvider(id: string, value: unknown): ModelProviderConfig {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidProvider(id, "Model provider must be a discriminated object");
  }
  if (value.type === "codex-builtin") {
    assertProviderKeys(value, ["type", "provider"], id);
    if (
      typeof value.provider !== "string" ||
      !(CODEX_BUILTIN_PROVIDERS as readonly string[]).includes(value.provider)
    ) {
      throw invalidProvider(id, "Built-in Codex provider is not supported");
    }
    return Object.freeze({
      type: "codex-builtin",
      provider: value.provider as (typeof CODEX_BUILTIN_PROVIDERS)[number],
    });
  }
  if (value.type !== "responses") {
    throw invalidProvider(id, "Model provider type is not supported");
  }
  assertProviderKeys(value, ["type", "name", "baseUrl", "wireApi", "apiKeyEnv"], id);
  const name = readProviderString(value.name, id, "name", MAX_PROVIDER_NAME_LENGTH);
  const baseUrl = parseResponsesBaseUrl(value.baseUrl, id);
  if (value.wireApi !== "responses") {
    throw invalidProvider(id, "Responses provider wireApi must be responses");
  }
  const apiKeyEnv = value.apiKeyEnv === undefined
    ? undefined
    : readProviderString(value.apiKeyEnv, id, "apiKeyEnv", 128);
  if (apiKeyEnv !== undefined && !ENVIRONMENT_NAME_PATTERN.test(apiKeyEnv)) {
    throw invalidProvider(id, "Responses provider apiKeyEnv must be an environment variable name");
  }
  return Object.freeze({
    type: "responses",
    name,
    baseUrl,
    wireApi: "responses",
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
  });
}

function parseOptionalAgent(
  value: unknown,
  projectId: string,
  modelProviders: ModelProviderMap,
): ProjectConfig["agent"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalidProject(projectId, "agent must be an object");
  const keys = new Set(["provider", "model"]);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw invalidProject(projectId, "agent contains an unknown setting");
  }
  const provider = readBoundedString(value.provider, projectId, "agent.provider", 64);
  const model = readBoundedString(value.model, projectId, "agent.model", MAX_MODEL_LENGTH);
  if (!modelProviders.has(provider)) {
    throw new ProjectConfigError(
      "MODEL_PROVIDER_REFERENCE_UNKNOWN",
      "Project agent references an unknown model provider",
      { projectId },
    );
  }
  return Object.freeze({ provider, model });
}

function assertProviderKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  providerId: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw invalidProvider(providerId, "Model provider contains an unknown setting");
  }
}

function readProviderString(
  value: unknown,
  providerId: string,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw invalidProvider(providerId, `${field} must be a non-empty bounded string`);
  }
  return value.trim();
}

function parseResponsesBaseUrl(value: unknown, providerId: string): string {
  const configured = readProviderString(value, providerId, "baseUrl", MAX_PROVIDER_URL_LENGTH);
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw invalidProvider(providerId, "baseUrl must be an absolute HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.hostname.length === 0
  ) {
    throw invalidProvider(providerId, "baseUrl must not contain credentials, query or fragment");
  }
  if (url.protocol === "http:" && !isPrivateHttpHost(url.hostname)) {
    throw invalidProvider(providerId, "Public HTTP baseUrl is not allowed");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function isPrivateHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 10 ||
    first === 127 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254);
}

function parseOptionalIssueTracker(
  value: unknown,
  projectId: string,
): IssueTrackerConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidTracker(projectId, "issueTracker must be a discriminated object");
  }

  if (value.type === "jira") {
    assertExactKeys(value, ["type"], projectId);
    return Object.freeze({ type: "jira" });
  }
  if (value.type !== "github") {
    throw new ProjectConfigError(
      "ISSUE_TRACKER_PROVIDER_UNKNOWN",
      "Issue tracker provider is not supported by configuration",
      { projectId },
    );
  }

  assertExactKeys(
    value,
    ["type", "owner", "repository", "tokenEnv", "writeTokenEnv", "apiBaseUrl", "apiVersion", "pageSize", "allowCreation"],
    projectId,
  );
  const owner = readGitHubName(value.owner, projectId, "owner", GITHUB_OWNER_MAX_LENGTH);
  const repository = readGitHubName(
    value.repository,
    projectId,
    "repository",
    GITHUB_REPOSITORY_MAX_LENGTH,
  );
  const tokenEnv = readTrackerString(value.tokenEnv, projectId, "tokenEnv", 128);
  if (!ENVIRONMENT_NAME_PATTERN.test(tokenEnv)) {
    throw invalidTracker(projectId, "issueTracker.tokenEnv must be a bounded environment variable name");
  }
  const apiBaseUrl = parseGitHubApiBaseUrl(value.apiBaseUrl, projectId);
  const apiVersion = readTrackerString(
    value.apiVersion,
    projectId,
    "apiVersion",
    10,
  );
  if (!isCalendarDate(apiVersion)) {
    throw invalidTracker(projectId, "issueTracker.apiVersion must use YYYY-MM-DD format");
  }
  const pageSize = value.pageSize === undefined ? GITHUB_DEFAULT_PAGE_SIZE : value.pageSize;
  if (typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > GITHUB_MAX_PAGE_SIZE) {
    throw invalidTracker(projectId, `issueTracker.pageSize must be between 1 and ${GITHUB_MAX_PAGE_SIZE}`);
  }
  if (value.allowCreation !== undefined && typeof value.allowCreation !== "boolean") {
    throw invalidTracker(projectId, "issueTracker.allowCreation must be a boolean");
  }
  const writeTokenEnv = value.writeTokenEnv === undefined
    ? undefined
    : readTrackerString(value.writeTokenEnv, projectId, "writeTokenEnv", 128);
  if (writeTokenEnv !== undefined && !ENVIRONMENT_NAME_PATTERN.test(writeTokenEnv)) {
    throw invalidTracker(projectId, "issueTracker.writeTokenEnv must be a bounded environment variable name");
  }
  if (value.allowCreation === true && writeTokenEnv === tokenEnv) {
    throw invalidTracker(projectId, "issueTracker.writeTokenEnv must differ from issueTracker.tokenEnv");
  }
  if (value.allowCreation === true && writeTokenEnv === undefined) {
    throw invalidTracker(projectId, "issueTracker.writeTokenEnv is required when issue creation is enabled");
  }

  return Object.freeze({
    type: "github",
    owner,
    repository,
    tokenEnv,
    ...(writeTokenEnv === undefined ? {} : { writeTokenEnv }),
    apiBaseUrl,
    apiVersion,
    pageSize,
    ...(value.allowCreation === true ? { allowCreation: true } : {}),
    limits: GITHUB_ISSUE_TRACKER_LIMITS,
  } satisfies GitHubIssueTrackerConfig);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  projectId: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw invalidTracker(projectId, "issueTracker contains an unknown provider setting");
  }
}

function readGitHubName(
  value: unknown,
  projectId: string,
  field: string,
  maxLength: number,
): string {
  const name = readTrackerString(value, projectId, field, maxLength);
  if (name === "." || name === ".." || !GITHUB_NAME_PATTERN.test(name)) {
    throw invalidTracker(projectId, `issueTracker.${field} must be a valid GitHub name segment`);
  }
  return name;
}

function parseGitHubApiBaseUrl(value: unknown, projectId: string): string {
  if (value === undefined) return GITHUB_DEFAULT_API_BASE_URL;
  const configured = readTrackerString(value, projectId, "apiBaseUrl", 2_048);
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw invalidTracker(projectId, "issueTracker.apiBaseUrl must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw invalidTracker(projectId, "issueTracker.apiBaseUrl must be an absolute HTTPS URL without credentials, query or fragment");
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (url.origin === GITHUB_DEFAULT_API_BASE_URL) {
    if (pathname.length > 0) {
      throw invalidTracker(projectId, "GitHub.com API base URL must be https://api.github.com");
    }
    return GITHUB_DEFAULT_API_BASE_URL;
  }
  if (pathname !== "/api/v3") {
    throw invalidTracker(projectId, "GitHub Enterprise API base URL must end with /api/v3");
  }
  return `${url.origin}${pathname}`;
}

function readTrackerString(
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
    throw invalidTracker(projectId, `issueTracker.${field} must be a non-empty bounded string`);
  }
  return value.trim();
}

function isCalendarDate(value: string): boolean {
  if (!API_VERSION_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
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

function parseOptionalAbsolutePath(value: unknown, projectId: string): string | undefined {
  if (value === undefined) return undefined;
  const path = readBoundedString(value, projectId, "codexHome", MAX_COMMAND_VALUE_LENGTH);
  if (!isAbsolute(path)) {
    throw invalidProject(projectId, "codexHome must be an absolute path");
  }
  return path;
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

function invalidTracker(projectId: string, message: string): ProjectConfigError {
  return new ProjectConfigError("ISSUE_TRACKER_INVALID", message, { projectId });
}

function invalidProvider(providerId: string, message: string): ProjectConfigError {
  return new ProjectConfigError("MODEL_PROVIDER_INVALID", message, { projectId: providerId });
}
