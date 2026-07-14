import type { FailureCategory } from "../providers/failures.js";
import { JobError } from "./errors.js";

export type RuntimeFailureCategory = Extract<
  FailureCategory,
  "insufficient_disk_space" | "disk_write_failure" | "database_unavailable"
>;

const insufficientSpaceCodes = new Set(["EDQUOT", "ENOSPC", "SQLITE_FULL"]);
const diskWriteCodes = new Set(["EACCES", "EIO", "EPERM", "EROFS"]);
const databaseCodes = new Set([
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR",
  "SQLITE_MISUSE",
  "SQLITE_READONLY",
]);

export function classifyRuntimeError(
  error: unknown,
): RuntimeFailureCategory | null {
  return classify(error, new Set());
}

export function isDatabaseUnavailableError(error: unknown): boolean {
  return classifyRuntimeError(error) === "database_unavailable";
}

function classify(
  error: unknown,
  seen: Set<unknown>,
): RuntimeFailureCategory | null {
  if (error === null || error === undefined || seen.has(error)) return null;
  if (typeof error === "object") seen.add(error);

  if (error instanceof JobError && error.code === "JOB_DATABASE_UNAVAILABLE")
    return "database_unavailable";

  const code = errorCode(error);
  if (code) {
    if (insufficientSpaceCodes.has(code)) return "insufficient_disk_space";
    if (diskWriteCodes.has(code)) return "disk_write_failure";
    if (
      databaseCodes.has(code) ||
      [...databaseCodes].some((prefix) => code.startsWith(`${prefix}_`))
    )
      return "database_unavailable";
  }

  if (
    error instanceof Error &&
    /database(?: connection)? is (?:not open|closed)/i.test(error.message)
  )
    return "database_unavailable";

  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const category = classify(nested, seen);
      if (category) return category;
    }
  }

  if (error instanceof Error && error.cause !== undefined)
    return classify(error.cause, seen);
  return null;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code.toUpperCase() : null;
}
