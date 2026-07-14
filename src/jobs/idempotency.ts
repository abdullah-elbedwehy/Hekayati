import { createHash } from "node:crypto";

import { JobError } from "./errors.js";

export function createRequestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createIdempotencyKey(value: unknown): string {
  return createRequestHash(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  assertJsonPrimitive(value);
  if (value === null || typeof value !== "object") return value;
  if (isBinary(value)) throw new JobError("JOB_BINARY_PERSISTENCE_FORBIDDEN");
  if (ancestors.has(value)) throw new JobError("JOB_CIRCULAR_INPUT_FORBIDDEN");
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => canonicalize(item, ancestors))
    : canonicalObject(value, ancestors);
  ancestors.delete(value);
  return result;
}

function canonicalObject(
  value: object,
  ancestors: Set<object>,
): Record<string, unknown> {
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new JobError("JOB_NON_JSON_INPUT_FORBIDDEN");
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item, ancestors)]),
  );
}

function assertJsonPrimitive(value: unknown): void {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new JobError("JOB_NON_JSON_INPUT_FORBIDDEN");
  }
}

function isBinary(value: object): boolean {
  return (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}
