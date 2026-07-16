export const printErrorCodes = [
  "PRINT_ENTITY_NOT_FOUND",
  "PRINT_DUPLICATE_ENTITY",
  "PRINT_REVISION_CONFLICT",
  "PRINT_REVISION_INVALID",
  "PRINT_IMMUTABLE_FIELD_CHANGED",
  "PRINT_SCOPE_REJECTED",
  "PRINTER_PROFILE_NOT_FOUND",
  "PRINTER_PROFILE_VERSION_NOT_FOUND",
  "PRINTER_PROFILE_ARCHIVED",
  "PRINTER_PROFILE_INCOMPLETE",
  "PRINTER_PROFILE_ASSET_INVALID",
  "PRINTER_PROFILE_ASSET_MISSING",
  "COMPOSITION_PROFILE_MISMATCH",
  "PRINT_IDEMPOTENCY_COLLISION",
  "PRINT_AUTHORIZATION_MISMATCH",
  "PRINT_RUN_STALE",
  "PRINT_ARTIFACT_NOT_DELIVERABLE",
  "PRINT_PROOF_ACTION_INVALID",
  "PRINT_PROOF_ACTION_COLLISION",
] as const;

export type PrintErrorCode = (typeof printErrorCodes)[number];

export class PrintError extends Error {
  readonly name = "PrintError";
  constructor(
    readonly code: PrintErrorCode,
    readonly statusCode = statusFor(code),
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(code);
  }
}

export function failPrint(
  code: PrintErrorCode,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new PrintError(code, statusFor(code), details);
}

function statusFor(code: PrintErrorCode): number {
  if (
    code === "PRINT_ENTITY_NOT_FOUND" ||
    code === "PRINTER_PROFILE_NOT_FOUND" ||
    code === "PRINTER_PROFILE_VERSION_NOT_FOUND"
  )
    return 404;
  if (code === "PRINT_SCOPE_REJECTED") return 404;
  if (
    code.includes("CONFLICT") ||
    code.includes("COLLISION") ||
    code === "PRINT_DUPLICATE_ENTITY" ||
    code === "PRINT_RUN_STALE"
  )
    return 409;
  return 422;
}
