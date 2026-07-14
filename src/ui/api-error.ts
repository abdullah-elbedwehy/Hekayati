export class ApiError extends Error {
  constructor(
    readonly category: "stale_session" | "request_failed",
    readonly code = "REQUEST_FAILED",
    readonly status = 0,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(category === "stale_session" ? "STALE_SESSION" : code);
  }
}
