export type CreativeErrorCode =
  | "CREATIVE_ENTITY_NOT_FOUND"
  | "CREATIVE_DUPLICATE_ENTITY"
  | "CREATIVE_SCOPE_MISMATCH"
  | "CREATIVE_REVISION_CONFLICT"
  | "CREATIVE_VERSION_CONFLICT"
  | "CREATIVE_PAGE_LOCKED"
  | "CREATIVE_PAGE_NOT_REVIEWED"
  | "CREATIVE_PAGE_STALE"
  | "CREATIVE_REVIEW_STALE"
  | "CREATIVE_APPROVAL_NOT_APPLICABLE"
  | "CREATIVE_FINDINGS_BLOCK"
  | "CREATIVE_RUN_STATE_INVALID"
  | "CREATIVE_JOB_NOT_BOUND"
  | "CREATIVE_DEPENDENCY_INCOMPLETE"
  | "CREATIVE_SHEET_NOT_APPROVED"
  | "CREATIVE_SHEET_REFERENCE_MISMATCH"
  | "CREATIVE_INVALIDATION_CONFLICT"
  | "CREATIVE_POLICY_CONFIRMATION_REQUIRED"
  | "CREATIVE_POLICY_CONFIRMATION_STALE"
  | "CREATIVE_POLICY_OUTPUT_REJECTED"
  | "CREATIVE_CAPACITY_CONFIRMATION_REQUIRED"
  | "CREATIVE_CAPACITY_CONFIRMATION_STALE"
  | "CREATIVE_CAPABILITY_UNAVAILABLE";

export class CreativeError extends Error {
  constructor(
    readonly code: CreativeErrorCode,
    readonly statusCode = 409,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(code);
    this.name = "CreativeError";
  }
}

export function failCreative(
  code: CreativeErrorCode,
  statusCode?: number,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new CreativeError(code, statusCode, details);
}
