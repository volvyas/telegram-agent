import type { IssueWriter, IssueCreationProposal, IssueDraft, CreatedIssueReference } from "./IssueWriter.js";

export const ISSUE_DRAFT_LIMITS = Object.freeze({ summary: 200, description: 12_000 });

export class IssueCreationError extends Error {
  public constructor(public readonly code: "INVALID_DRAFT" | "PROJECT_MISMATCH" | "PROPOSAL_USED", message: string) {
    super(message);
    this.name = "IssueCreationError";
  }
}

export class IssueCreationService {
  readonly #writers: ReadonlyMap<string, IssueWriter>;
  readonly #used = new Set<string>();
  readonly #secrets: readonly string[];

  public constructor(writers: ReadonlyMap<string, IssueWriter> | Record<string, IssueWriter>, secrets: readonly string[] = []) {
    this.#writers = writers instanceof Map ? writers : new Map(Object.entries(writers));
    this.#secrets = Object.freeze([...secrets]);
  }

  public propose(projectId: string, provider: IssueCreationProposal["provider"], draft: IssueDraft, secrets: readonly string[] = []): IssueCreationProposal {
    if (provider !== "github" || !this.#writers.has(projectId)) {
      throw new IssueCreationError("INVALID_DRAFT", "Issue creation is not enabled for this project/provider");
    }
    const normalized = normalizeDraft(draft, [...this.#secrets, ...secrets]);
    return Object.freeze({ kind: "issue_creation", projectId, provider, draft: normalized });
  }

  public async create(proposal: IssueCreationProposal, projectId: string, confirmationId: string, signal?: AbortSignal): Promise<CreatedIssueReference> {
    if (proposal.projectId !== projectId) throw new IssueCreationError("PROJECT_MISMATCH", "Issue proposal belongs to another project");
    if (this.#used.has(confirmationId)) throw new IssueCreationError("PROPOSAL_USED", "Issue proposal was already used");
    const writer = this.#writers.get(projectId);
    if (writer === undefined) throw new IssueCreationError("INVALID_DRAFT", "Issue creation is not enabled for this project");
    // Mark before the network call: a caller cannot replay a proposal after an
    // ambiguous provider response.
    this.#used.add(confirmationId);
    return writer.createIssue(normalizeDraft(proposal.draft, this.#secrets), signal);
  }
}

export function normalizeDraft(draft: IssueDraft, secrets: readonly string[] = []): IssueDraft {
  if (!draft || typeof draft.summary !== "string" || typeof draft.description !== "string") {
    throw new IssueCreationError("INVALID_DRAFT", "Issue draft is invalid");
  }
  const summary = redact(draft.summary.trim(), secrets).replace(/[\r\n]+/gu, " ");
  const description = redact(draft.description.trim(), secrets);
  if (!summary || summary.length > ISSUE_DRAFT_LIMITS.summary || !description || description.length > ISSUE_DRAFT_LIMITS.description || hasControlCharacter(`${summary}\n${description}`)) {
    throw new IssueCreationError("INVALID_DRAFT", "Issue draft exceeds the safe limits");
  }
  for (const section of ["context", "observed behavior", "expected behavior", "acceptance criteria"]) {
    if (!new RegExp(`^#{1,6}\\s*${section.replace(/ /gu, "\\s+")}\\s*$`, "imu").test(description)) {
      throw new IssueCreationError("INVALID_DRAFT", "Issue description is missing a required section");
    }
  }
  if (/\b(?:[A-Za-z]:[\\/]|\/home\/|\/Users\/|\/tmp\/)[^\s]*/u.test(`${summary}\n${description}`)) {
    throw new IssueCreationError("INVALID_DRAFT", "Issue draft contains a local path");
  }
  return Object.freeze({ summary, description });
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true;
  }
  return false;
}

function redact(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  return result;
}
