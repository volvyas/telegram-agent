import type {
  GitHubIssueTrackerConfig,
  IssueTrackerSecrets,
} from "../config/IssueTrackerConfig.js";
import type { ProjectConfig } from "../config/ProjectConfig.js";
import {
  IssueTrackerError,
  type IssueTracker,
} from "./IssueTracker.js";

/** Construction seam implemented by the GitHub adapter in DEV-052. */
export type GitHubIssueTrackerFactory = (
  config: GitHubIssueTrackerConfig,
  token: string,
) => IssueTracker;

export class IssueTrackerResolver {
  readonly #secrets: IssueTrackerSecrets;
  readonly #createGitHubTracker: GitHubIssueTrackerFactory;

  public constructor(
    secrets: IssueTrackerSecrets,
    createGitHubTracker: GitHubIssueTrackerFactory,
  ) {
    this.#secrets = secrets;
    this.#createGitHubTracker = createGitHubTracker;
  }

  public resolve(project: ProjectConfig): IssueTracker {
    const config = project.issueTracker;
    if (config === undefined) {
      throw new IssueTrackerError(
        "NOT_CONFIGURED",
        "Issue tracker is not configured for this project",
        { projectId: project.id },
      );
    }

    if (config.type === "jira") {
      throw new IssueTrackerError(
        "UNSUPPORTED_PROVIDER",
        "Configured issue tracker provider is not supported",
        { provider: config.type, projectId: project.id },
      );
    }

    const token = this.#secrets.getGitHubToken(project.id);
    if (token === undefined) {
      throw new IssueTrackerError(
        "CREDENTIAL_UNAVAILABLE",
        "Issue tracker credential is unavailable",
        { provider: config.type, projectId: project.id },
      );
    }
    return this.#createGitHubTracker(config, token);
  }
}
