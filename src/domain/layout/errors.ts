export type LayoutErrorCode =
  | "LAYOUT_ENTITY_NOT_FOUND"
  | "LAYOUT_DUPLICATE_ENTITY"
  | "LAYOUT_REVISION_INVALID"
  | "LAYOUT_REVISION_CONFLICT"
  | "LAYOUT_IMMUTABLE_FIELD_CHANGED"
  | "LAYOUT_MIGRATION_CONFLICT"
  | "LAYOUT_PROFILE_MISMATCH"
  | "LAYOUT_PAGE_NOT_FOUND"
  | "LAYOUT_PAGE_KIND_INVALID"
  | "LAYOUT_SOURCE_NOT_FOUND"
  | "LAYOUT_REVIEW_REQUIRED"
  | "LAYOUT_LOCKED_REPLACEMENT"
  | "LAYOUT_WORK_REQUEST_STALE"
  | "LAYOUT_STALE_INPUT"
  | "LAYOUT_COMPOSITION_SOURCE_REQUIRED"
  | "LAYOUT_WORKFLOW_NOT_FOUND"
  | "LAYOUT_WORKFLOW_CONFLICT"
  | "LAYOUT_WORKFLOW_NOT_READY"
  | "LAYOUT_PREVIEW_STALE"
  | "LAYOUT_PREVIEW_ASSET_INVALID";

export class LayoutError extends Error {
  readonly name = "LayoutError";

  constructor(
    readonly code: LayoutErrorCode,
    readonly statusCode = 409,
  ) {
    super(code);
  }
}

export function failLayout(code: LayoutErrorCode, statusCode?: number): never {
  throw new LayoutError(code, statusCode);
}
