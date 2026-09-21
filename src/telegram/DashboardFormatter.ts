import type { AgentStatus } from "../agent/AgentManager.js";
import type { AgentSession } from "../domain/AgentSession.js";
import type { ProjectConfig } from "../config/ProjectConfig.js";
import type { GitPorcelainEntry } from "../git/GitOutputParser.js";
import type { GitStatus } from "../git/GitService.js";

const MAX_FILE_ROWS = 40;
const MAX_DISPLAY_PATH_LENGTH = 240;
const MAX_MESSAGE_LENGTH = 4_096;

export function formatGitDashboard(project: ProjectConfig, status: GitStatus): string {
  const lines = [
    `Git: ${project.name} (${project.id})`,
    `Branch: ${formatBranch(status.branch)}`,
    `Status: ${status.clean ? "clean" : "dirty"}`,
  ];

  if (status.clean) {
    lines.push("Changed files: 0");
  } else {
    lines.push(
      `Changed files: ${String(status.changedFiles.length)}`,
      `Diff summary: ${formatNumstat(status)}`,
    );
    for (const entry of status.porcelain.slice(0, MAX_FILE_ROWS)) {
      lines.push(formatFileEntry(entry));
    }
    if (status.porcelain.length > MAX_FILE_ROWS) {
      lines.push(`… and ${String(status.porcelain.length - MAX_FILE_ROWS)} more`);
    }
  }

  return boundMessage(lines.join("\n"));
}

export function formatStatusDashboard(
  project: ProjectConfig,
  agent: AgentStatus,
  session: AgentSession | undefined,
  git: GitStatus,
): string {
  return boundMessage([
    `Project: ${project.name} (${project.id})`,
    `Agent: ${agent.state}${agent.active ? " (active)" : ""}`,
    `Session: ${formatSession(agent, session)}`,
    `Git: ${formatBranch(git.branch)} · ${formatShortGitStatus(git)}`,
  ].join("\n"));
}

function formatFileEntry(entry: GitPorcelainEntry): string {
  const state = `${entry.index}${entry.workTree}`;
  const path = escapePath(entry.path);
  const displayPath = entry.originalPath === undefined
    ? path
    : `${escapePath(entry.originalPath)} → ${path}`;
  return `• [${state}] ${displayPath}`;
}

function escapePath(path: string): string {
  const escaped = path
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t");
  return escaped.length <= MAX_DISPLAY_PATH_LENGTH
    ? escaped
    : `${escaped.slice(0, MAX_DISPLAY_PATH_LENGTH - 1)}…`;
}

function formatBranch(branch: string | null): string {
  return branch ?? "detached HEAD";
}

function formatNumstat(status: GitStatus): string {
  const summary = `+${String(status.numstat.additions)}/-${String(status.numstat.deletions)}`;
  return status.numstat.binaryFiles === 0
    ? summary
    : `${summary}, ${String(status.numstat.binaryFiles)} binary`;
}

function formatShortGitStatus(status: GitStatus): string {
  if (status.clean) return "clean";
  const count = `${String(status.changedFiles.length)} changed`;
  const hasTextDiff = status.numstat.additions > 0 || status.numstat.deletions > 0;
  const textDiff = hasTextDiff
    ? `, +${String(status.numstat.additions)}/-${String(status.numstat.deletions)}`
    : "";
  const binary = status.numstat.binaryFiles > 0
    ? `, ${String(status.numstat.binaryFiles)} binary`
    : "";
  return `${count}${textDiff}${binary}`;
}

function formatSession(agent: AgentStatus, session: AgentSession | undefined): string {
  if (agent.active) return "active";
  if (session?.threadId !== undefined) return "resumable";
  return "none";
}

function boundMessage(message: string): string {
  return message.length <= MAX_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}
