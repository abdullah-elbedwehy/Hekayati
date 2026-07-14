export const authoringErrorCodes = [
  "PROJECT_NOT_FOUND",
  "PROJECT_VERSION_NOT_FOUND",
  "PROJECT_VERSION_CONFLICT",
  "PROJECT_FAMILY_SCOPE_VIOLATION",
  "PROJECT_MAIN_CHILD_INVALID",
  "PROJECT_PARTICIPANT_REQUIRED",
  "PROJECT_OVERRIDE_NOT_FOUND",
  "PROJECT_OVERRIDE_VERSION_CONFLICT",
  "TEMPLATE_NOT_FOUND",
  "TEMPLATE_VERSION_NOT_FOUND",
  "TEMPLATE_VERSION_CONFLICT",
  "TEMPLATE_REQUIRED",
  "TEMPLATE_NOT_SELECTABLE",
  "CUSTOM_STORY_INCOMPLETE",
  "MENTION_UNRESOLVED",
  "MENTION_GROUP_EMPTY",
  "MENTION_CHARACTER_NOT_IN_PROJECT",
  "MENTION_LOOK_NOT_OWNED",
  "PARTICIPANT_RECONCILIATION_REQUIRED",
  "MODEL_CAPABILITY_UNAVAILABLE",
  "PARTICIPANT_CAPACITY_CONFIRMATION_REQUIRED",
  "CHARACTER_REMOVAL_RESOLUTION_REQUIRED",
  "PAGE_COUNT_PREFLIGHT_REQUIRED",
  "PAGE_COUNT_PREFLIGHT_STALE",
  "STORY_NOT_FOUND",
  "STORY_VERSION_CONFLICT",
  "SCENE_NOT_FOUND",
  "SCENE_VERSION_CONFLICT",
  "STORY_STRUCTURE_INCOMPLETE",
  "CROSS_FAMILY_ROLE_REMAP_REQUIRED",
  "PRIVACY_SCAN_FAILED",
  "DUPLICATE_AUTHORING_ID",
] as const;

export type AuthoringErrorCode = (typeof authoringErrorCodes)[number];

const conflictCodes = new Set<AuthoringErrorCode>([
  "PROJECT_VERSION_CONFLICT",
  "PROJECT_OVERRIDE_VERSION_CONFLICT",
  "TEMPLATE_VERSION_CONFLICT",
  "PARTICIPANT_RECONCILIATION_REQUIRED",
  "PARTICIPANT_CAPACITY_CONFIRMATION_REQUIRED",
  "CHARACTER_REMOVAL_RESOLUTION_REQUIRED",
  "PAGE_COUNT_PREFLIGHT_REQUIRED",
  "PAGE_COUNT_PREFLIGHT_STALE",
  "STORY_VERSION_CONFLICT",
  "SCENE_VERSION_CONFLICT",
  "CROSS_FAMILY_ROLE_REMAP_REQUIRED",
  "DUPLICATE_AUTHORING_ID",
]);

const notFoundCodes = new Set<AuthoringErrorCode>([
  "PROJECT_NOT_FOUND",
  "PROJECT_VERSION_NOT_FOUND",
  "PROJECT_OVERRIDE_NOT_FOUND",
  "TEMPLATE_NOT_FOUND",
  "TEMPLATE_VERSION_NOT_FOUND",
  "STORY_NOT_FOUND",
  "SCENE_NOT_FOUND",
]);

/** Safe domain failure. Details contain only stable field names or record IDs. */
export class AuthoringError extends Error {
  readonly name = "AuthoringError";
  readonly statusCode: number;

  constructor(
    readonly code: AuthoringErrorCode,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(code);
    this.statusCode = statusFor(code);
  }
}

export function failAuthoring(
  code: AuthoringErrorCode,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new AuthoringError(code, details);
}

function statusFor(code: AuthoringErrorCode): number {
  if (code === "PROJECT_FAMILY_SCOPE_VIOLATION") return 403;
  if (notFoundCodes.has(code)) return 404;
  if (conflictCodes.has(code)) return 409;
  return 422;
}
