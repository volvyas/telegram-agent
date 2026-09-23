import type { Context } from "grammy";

import type {
  AgentStatus,
  GitStatusReader,
} from "../../agent/AgentManager.js";
import type { AgentSession } from "../../domain/AgentSession.js";
import type { ProjectHandler } from "./ProjectHandler.js";
import { formatStatusDashboard } from "../DashboardFormatter.js";
import { DEFAULT_OPERATION_POLICY, type OperationPolicy } from "../../policy/OperationPolicy.js";

export interface AgentStatusReader {
  getStatus(projectId: string): AgentStatus;
  getSession(projectId: string): AgentSession | undefined;
}

export class StatusHandler {
  readonly #projects: ProjectHandler;
  readonly #agent: AgentStatusReader;
  readonly #git: GitStatusReader;
  readonly #policy: OperationPolicy;

  public constructor(
    projects: ProjectHandler,
    agent: AgentStatusReader,
    git: GitStatusReader,
    policy = DEFAULT_OPERATION_POLICY,
  ) {
    this.#projects = projects;
    this.#agent = agent;
    this.#git = git;
    this.#policy = policy;
  }

  public async handleStatusCommand(context: Context): Promise<void> {
    const userId = context.from?.id;
    const project = userId === undefined
      ? undefined
      : await this.#projects.restoreActiveProject(userId);
    if (project === undefined) {
      await context.reply("Select a project first with /projects.");
      return;
    }
    if (this.#policy.evaluate(project, "status").kind === "forbidden") {
      await context.reply("Status is not allowed for this project.");
      return;
    }

    try {
      const agent = this.#agent.getStatus(project.id);
      const session = this.#agent.getSession(project.id);
      const git = await this.#git.getStatus(project.path);
      await context.reply(formatStatusDashboard(project, agent, session, git));
    } catch {
      await context.reply("Unable to read project status.");
    }
  }
}
