import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

import { PhotoIntakeError } from "../assets/photo-intake/index.js";
import { AuthoringError } from "../domain/authoring/index.js";
import { CreativeError } from "../domain/creative/index.js";
import { ApprovalError } from "../domain/layout/approvals.js";
import { LayoutError } from "../domain/layout/errors.js";
import { PrintError } from "../domain/print/errors.js";
import { LibraryError } from "../domain/library/errors.js";
import { JobError } from "../jobs/errors.js";
import { ProviderTargetChangeError } from "../jobs/provider-target-change.js";
import { SecretPersistenceError } from "../security/secret-registry.js";
import type { StructuredLogger } from "../security/log.js";
import { PhotoReservationError } from "./photo-intake/reservations.js";
import { ProviderServiceError } from "./providers/provider-service.js";

export function handleError(
  error: unknown,
  reply: FastifyReply,
  logger: StructuredLogger,
): void {
  if (handleValidationError(error, reply)) return;
  if (error instanceof SecretPersistenceError)
    return sendCode(reply, 400, "INVALID_INPUT");
  if (error instanceof LibraryError)
    return sendCode(reply, error.statusCode, error.code);
  if (error instanceof AuthoringError || error instanceof CreativeError)
    return sendCode(reply, error.statusCode, error.code, error.details);
  if (error instanceof LayoutError || error instanceof ApprovalError)
    return sendCode(reply, error.statusCode, error.code);
  if (error instanceof PrintError)
    return sendCode(reply, error.statusCode, error.code, error.details);
  if (error instanceof PhotoIntakeError) {
    void reply.code(error.statusCode).send(error.toSafeResponse());
    return;
  }
  if (
    error instanceof PhotoReservationError ||
    error instanceof ProviderServiceError ||
    error instanceof ProviderTargetChangeError ||
    error instanceof JobError
  )
    return sendCode(reply, error.statusCode, error.code);
  handleUnexpectedError(error, reply, logger);
}

function sendCode(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  details?: unknown,
): void {
  void reply
    .code(statusCode)
    .send(details === undefined ? { code } : { code, details });
}

function handleUnexpectedError(
  error: unknown,
  reply: FastifyReply,
  logger: StructuredLogger,
): void {
  const status = clientErrorStatus(error);
  if (status !== null) {
    void reply.code(status).send({
      code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
    });
    return;
  }
  logger.error("request_failed", {
    error: error instanceof Error ? error : new Error("UNKNOWN_ERROR"),
  });
  void reply.code(500).send({ code: "INTERNAL_ERROR" });
}

function handleValidationError(error: unknown, reply: FastifyReply): boolean {
  if (!(error instanceof ZodError)) return false;
  void reply.code(400).send({
    code: "INVALID_INPUT",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
  return true;
}

function clientErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("statusCode" in error))
    return null;
  const status = error.statusCode;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : null;
}
