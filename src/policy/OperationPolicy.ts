import { ALLOWED_OPERATIONS, type AllowedOperation, type ProjectConfig } from "../config/ProjectConfig.js";

export const FORBIDDEN_OPERATIONS = ["push", "reset-hard", "clean", "checkout-discard"] as const;
export const CONFIRMATION_REQUIRED_OPERATIONS = ["commit"] as const;
export type ForbiddenOperation = (typeof FORBIDDEN_OPERATIONS)[number];
export type OperationDecisionKind = "allowed" | "confirmation_required" | "forbidden";

export interface OperationDecision {
  readonly kind: OperationDecisionKind;
  readonly operation: string;
  readonly reason: string;
}

/** Central policy for project operations and destructive Git actions. */
export class OperationPolicy {
  public evaluate(project: ProjectConfig, operation: string): OperationDecision {
    if (isForbiddenOperation(operation)) {
      return Object.freeze({ kind: "forbidden", operation, reason: `Operation ${operation} is forbidden by the default security policy` });
    }
    if (!isAllowedOperation(operation) || !project.allowedOperations.has(operation)) {
      return Object.freeze({ kind: "forbidden", operation, reason: `Operation ${operation} is not enabled for project ${project.id}` });
    }
    if (isConfirmationRequired(operation)) {
      return Object.freeze({ kind: "confirmation_required", operation, reason: `Operation ${operation} requires explicit confirmation` });
    }
    return Object.freeze({ kind: "allowed", operation, reason: "Operation is enabled" });
  }

  public isEnabled(project: ProjectConfig, operation: string): boolean {
    return this.evaluate(project, operation).kind !== "forbidden";
  }

  public requiresConfirmation(operation: string): boolean {
    return isConfirmationRequired(operation);
  }
}

export const DEFAULT_OPERATION_POLICY = new OperationPolicy();

function isAllowedOperation(value: string): value is AllowedOperation {
  return (ALLOWED_OPERATIONS as readonly string[]).includes(value);
}

function isForbiddenOperation(value: string): value is ForbiddenOperation {
  return (FORBIDDEN_OPERATIONS as readonly string[]).includes(value);
}

function isConfirmationRequired(value: string): boolean {
  return (CONFIRMATION_REQUIRED_OPERATIONS as readonly string[]).includes(value);
}
