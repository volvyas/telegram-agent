import type { IssueDetails } from "../issues/IssueTracker.js";

const MAX_FORMATTED_BODY = 12_000;

export class IssueFormatter {
  public format(issue: IssueDetails): string {
  const lines = [
    `${issue.reference} · ${issue.state}`,
    `Title: ${issue.title}`,
    ...(issue.repository === undefined ? [] : [`Repository: ${issue.repository}`]),
    ...(issue.url === undefined ? [] : [`URL: ${issue.url}`]),
    ...(issue.author === undefined ? [] : [`Author: ${issue.author}`]),
    ...(issue.assignees.length === 0 ? [] : [`Assignees: ${issue.assignees.join(", ")}`]),
    ...(issue.labels.length === 0 ? [] : [`Labels: ${issue.labels.join(", ")}`]),
    ...(issue.milestone === undefined ? [] : [`Milestone: ${issue.milestone}`]),
    ...(issue.metadata.stateReason === undefined ? [] : [`State reason: ${issue.metadata.stateReason}`]),
    `Created: ${issue.createdAt}`,
    `Updated: ${issue.updatedAt}`,
    ...(issue.closedAt === undefined ? [] : [`Closed: ${issue.closedAt}`]),
  ];
  if (issue.body !== undefined && issue.body.length > 0) {
    lines.push("", "Body:", issue.body.slice(0, MAX_FORMATTED_BODY));
  }
    return lines.join("\n");
  }
}

export function formatIssue(issue: IssueDetails): string {
  return new IssueFormatter().format(issue);
}
