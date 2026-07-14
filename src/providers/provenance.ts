import { createHash } from "node:crypto";

import { z } from "zod";

import { provenanceSchema, type Provenance } from "./contract.js";

const provenanceInputSchema = provenanceSchema
  .omit({ settingsSnapshotHash: true })
  .extend({ settings: z.unknown() })
  .strict();

export function settingsSnapshotHash(settings: unknown): string {
  return createHash("sha256").update(canonicalJson(settings)).digest("hex");
}

export function createProvenance(input: unknown): Provenance {
  const parsed = provenanceInputSchema.parse(input);
  return provenanceSchema.parse({
    provider: parsed.provider,
    modelId: parsed.modelId,
    at: parsed.at,
    inputVersionRefs: parsed.inputVersionRefs,
    promptVersion: parsed.promptVersion,
    referenceAssetIds: parsed.referenceAssetIds,
    attempt: parsed.attempt,
    settingsSnapshotHash: settingsSnapshotHash(parsed.settings),
  });
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    throw new Error("BINARY_CANONICALIZATION_FORBIDDEN");
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}
