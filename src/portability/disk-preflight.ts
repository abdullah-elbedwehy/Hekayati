import { statfs } from "node:fs/promises";

import type { ImportDiskFacts } from "../domain/portability/import-model.js";
import { ArchiveValidationError } from "./archive-policy.js";

export const IMPORT_WORKSPACE_FLOOR_BYTES = 256 * 1024 ** 2;

export interface ImportDiskPreflightInput {
  freeBytes: number;
  reserveBytes: number;
  declaredUncompressedBytes: number;
  newContentBytes: number;
  canonicalDocumentBytes: number;
}

export interface ImportDiskProbeInput {
  root: string;
  reserveBytes: number;
  declaredUncompressedBytes: number;
  newContentBytes: number;
  canonicalDocumentBytes: number;
}

export function calculateImportDiskFacts(
  input: ImportDiskPreflightInput,
): ImportDiskFacts {
  for (const value of [
    input.freeBytes,
    input.reserveBytes,
    input.declaredUncompressedBytes,
    input.newContentBytes,
    input.canonicalDocumentBytes,
  ])
    assertSafeCount(value);
  const documentWorkspaceBytes = safeMultiply(input.canonicalDocumentBytes, 2);
  const workingBytes = Math.max(
    documentWorkspaceBytes,
    IMPORT_WORKSPACE_FLOOR_BYTES,
  );
  const requiredBytes = safeSum([
    input.declaredUncompressedBytes,
    input.newContentBytes,
    workingBytes,
  ]);
  const minimumFree = safeSum([requiredBytes, input.reserveBytes]);
  if (input.freeBytes < minimumFree)
    throw new ArchiveValidationError("IMPORT_DISK_SPACE_INSUFFICIENT", "disk");
  return { ...input, requiredBytes };
}

export async function preflightImportDisk(
  input: ImportDiskProbeInput,
): Promise<ImportDiskFacts> {
  const facts = await statfs(input.root);
  return calculateImportDiskFacts({
    ...input,
    freeBytes: safeMultiply(facts.bavail, facts.bsize),
  });
}

function assertSafeCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ArchiveValidationError("IMPORT_DISK_SIZE_OVERFLOW", "disk");
}

function safeMultiply(left: number, right: number): number {
  const value = left * right;
  assertSafeCount(value);
  return value;
}

function safeSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    assertSafeCount(value);
    total += value;
    assertSafeCount(total);
  }
  return total;
}
