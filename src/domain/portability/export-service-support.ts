import { ManagedExportReleaseError } from "../../portability/managed-export-store.js";
import {
  createManifest,
  type ManifestMediaEntry,
  type ManifestV2,
} from "../../portability/manifest.js";
import type { JobRecord } from "../../jobs/schemas.js";
import type { Project } from "../authoring/schemas.js";
import type {
  ExportOperation,
  ManagedExport,
  PortabilitySnapshot,
  PortabilitySnapshotEntry,
} from "./export-model.js";
import type { PortabilityAction } from "./schemas.js";

export function assertPauseAcknowledgements(input: {
  acknowledgedChildPhotos: boolean;
  acknowledgedNoAutomaticBackup: boolean;
}): void {
  if (!input.acknowledgedChildPhotos || !input.acknowledgedNoAutomaticBackup)
    throw new Error("PORTABILITY_EXPORT_WARNING_ACK_REQUIRED");
}

export function capturedProjectAttempts(
  jobs: readonly JobRecord[],
  projectId: string,
): Array<{ jobId: string; attempt: number }> {
  return jobs
    .filter(
      (job) =>
        job.projectId === projectId &&
        (job.state === "claimed" || job.state === "running"),
    )
    .map((job) => ({ jobId: job.id, attempt: job.attempts }));
}

export function initialOperation(input: {
  operationId: string;
  project: Project;
  idempotencyKey: string;
  requestHash: string;
  now: string;
}): ExportOperation {
  return {
    id: input.operationId,
    schemaVersion: 1,
    createdAt: input.now,
    updatedAt: input.now,
    revision: 0,
    projectId: input.project.id,
    customerId: input.project.customerId,
    familyId: input.project.familyId,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    projectRevision: input.project.revision,
    state: "waiting_pause",
    snapshotId: null,
    snapshotHash: null,
    documentCount: 0,
    mediaCount: 0,
    totalUncompressedBytes: 0,
    manifestHash: null,
    archiveKey: null,
    archiveChecksum: null,
    archiveBytes: null,
    failureCode: null,
    cleanupState: "none",
  };
}

export function inlineEntityId(
  action: PortabilityAction,
  index: number,
): string {
  if (action.result.kind !== "inline" || !action.result.entityIds[index])
    throw new Error("PORTABILITY_EXPORT_ACTION_RESULT_INVALID");
  return action.result.entityIds[index];
}

export function requiredHash(value: string | null): string {
  if (!value) throw new Error("PORTABILITY_EXPORT_HASH_REQUIRED");
  return value;
}

export function assertExecutableState(operation: ExportOperation): void {
  if (
    operation.state !== "staging" &&
    operation.state !== "packaging" &&
    operation.state !== "secret_scanning"
  )
    throw new Error("PORTABILITY_EXPORT_STATE_INVALID");
}

export function manifestForOperation(
  operation: ExportOperation,
  snapshot: PortabilitySnapshot,
  entries: readonly PortabilitySnapshotEntry[],
  appVersion: string,
): ManifestV2 {
  if (
    !snapshot.snapshotHash ||
    operation.snapshotHash !== snapshot.snapshotHash ||
    operation.snapshotId !== snapshot.id
  )
    throw new Error("PORTABILITY_EXPORT_SNAPSHOT_MISMATCH");
  const listed = manifestEntries(entries);
  const manifest = createManifest({
    appVersion,
    createdAt: operation.createdAt,
    exportId: operation.id,
    mode: "project",
    scope: {
      kind: "project",
      projectId: operation.projectId,
      customerId: operation.customerId,
      familyId: operation.familyId,
    },
    roots: [
      { kind: "project", id: operation.projectId },
      { kind: "customer", id: operation.customerId },
      { kind: "family", id: operation.familyId },
    ],
    documents: listed.documents,
    media: listed.media,
    snapshotHash: snapshot.snapshotHash,
  });
  if (
    operation.manifestHash &&
    operation.manifestHash !== manifest.manifestHash
  )
    throw new Error("PORTABILITY_EXPORT_MANIFEST_MISMATCH");
  return manifest;
}

function manifestEntries(entries: readonly PortabilitySnapshotEntry[]) {
  return {
    documents: entries.filter(isDocumentEntry).map((entry) => ({
      collection: entry.collection,
      id: entry.documentId,
      schemaVersion: entry.documentSchemaVersion,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
    media: entries.filter(isMediaEntry).map((entry) => ({
      namespace: entry.namespace,
      assetId: entry.mediaId,
      role: entry.role as ManifestMediaEntry["role"],
      mime: entry.mime,
      extension: entry.extension,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
  };
}

export function managedExportRecord(
  operation: ExportOperation,
  now: string,
): ManagedExport {
  if (
    operation.state !== "ready" ||
    !operation.snapshotHash ||
    !operation.manifestHash ||
    !operation.archiveKey ||
    !operation.archiveChecksum ||
    !operation.archiveBytes
  )
    throw new Error("PORTABILITY_EXPORT_READY_INCOMPLETE");
  return {
    id: operation.id,
    exportId: operation.id,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    operationId: operation.id,
    projectId: operation.projectId,
    customerId: operation.customerId,
    familyId: operation.familyId,
    archiveKey: operation.archiveKey,
    manifestVersion: 2,
    snapshotHash: operation.snapshotHash,
    manifestHash: operation.manifestHash,
    archiveChecksum: operation.archiveChecksum,
    bytes: operation.archiveBytes,
    secretScan: {
      passed: true,
      candidateScanPassed: true,
      finalizedArchiveScanPassed: true,
      scannedAt: now,
    },
  };
}

export function executionFailureCode(error: unknown): string {
  return error instanceof ManagedExportReleaseError
    ? "EXPORT_SECRET_FOUND"
    : "EXPORT_EXECUTION_FAILED";
}

function isDocumentEntry(
  entry: PortabilitySnapshotEntry,
): entry is Extract<PortabilitySnapshotEntry, { entryType: "document" }> {
  return entry.entryType === "document";
}

function isMediaEntry(
  entry: PortabilitySnapshotEntry,
): entry is Extract<PortabilitySnapshotEntry, { entryType: "media" }> {
  return entry.entryType === "media";
}
