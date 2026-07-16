import { createHash } from "node:crypto";

import type { MediaCleanupIntent } from "../../assets/media-reference.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import type { BaseDocument } from "../repository/document-store.js";
import type {
  DeletionReportDetailLedgerEntry,
  ManagedUnlinkLedgerEntry,
} from "./deletion-ledger.js";
import type { DeletionInventorySnapshot } from "./deletion-inventory.js";
import {
  deletionOperationSchema,
  deletionReportSchema,
  type DeletionInventory,
  type DeletionOperation,
  type DeletionReport,
} from "./deletion-model.js";

export function createInitialDeletionOperation(input: {
  operationId: string;
  recordedAt: string;
  inventory: DeletionInventory;
  lockId: string;
  lockRevision: number;
  canceledJobs: number;
  unlinkItems: number;
  unlinkRoot: string;
  sharedRoot: string;
  verificationRoot: string;
  reportRoot: string;
}): DeletionOperation {
  const { operationId, recordedAt, inventory } = input;
  return deletionOperationSchema.parse({
    id: operationId,
    schemaVersion: 1,
    createdAt: recordedAt,
    updatedAt: recordedAt,
    revision: 0,
    target: inventory.target,
    inventoryId: inventory.id,
    inventoryHash: inventory.inventoryHash,
    idempotencyKey: "deletion_confirm",
    requestHash: hash({
      inventoryId: inventory.id,
      inventoryHash: inventory.inventoryHash,
    }),
    state: "unlinking",
    lockId: input.lockId,
    lockRevision: input.lockRevision,
    counts: {
      ...inventory.counts,
      canceledJobs: input.canceledJobs,
      deletedDocuments: inventory.counts.documents + inventory.counts.jobs,
      unlinkItems: input.unlinkItems,
      failedChecks: 0,
    },
    inventoryLedgerRoot: inventory.inventoryLedgerRoot,
    blockerLedgerRoot: inventory.blockerLedgerRoot,
    unlinkLedgerRoot: input.unlinkRoot,
    sharedPreservedLedgerRoot: input.sharedRoot,
    verificationLedgerRoot: input.verificationRoot,
    reportDetailLedgerRoot: input.reportRoot,
    reportId: null,
    failureCode: null,
    verifiedAt: null,
  });
}

export function createVerifiedDeletionReport(
  operation: DeletionOperation,
  verificationRoot: string,
  verifiedAt: string,
): DeletionReport {
  return deletionReportSchema.parse({
    id: operation.id,
    schemaVersion: 1,
    createdAt: verifiedAt,
    updatedAt: verifiedAt,
    operationId: operation.id,
    targetKind: operation.target.kind,
    targetIdHash: operation.target.idHash,
    inventoryId: operation.inventoryId,
    inventoryHash: operation.inventoryHash,
    counts: { ...operation.counts, failedChecks: 0 },
    inventoryLedgerRoot: operation.inventoryLedgerRoot,
    unlinkLedgerRoot: operation.unlinkLedgerRoot,
    sharedPreservedLedgerRoot: operation.sharedPreservedLedgerRoot,
    verificationLedgerRoot: verificationRoot,
    reportDetailLedgerRoot: operation.reportDetailLedgerRoot,
    verifiedAt,
    failedChecks: 0,
  });
}

export function exportDeletionUnlinks(
  snapshot: DeletionInventorySnapshot,
): ManagedUnlinkLedgerEntry[] {
  const exports = new Map(
    snapshot.inventoryEntries
      .filter((entry) => entry.entryType === "deletion_export")
      .map((entry) => [entry.exportId, entry]),
  );
  const result: ManagedUnlinkLedgerEntry[] = [];
  for (const item of snapshot.deleteOrder) {
    if (item.collection !== "managed_exports") continue;
    const entry = exports.get(item.id);
    const document = item.document as BaseDocument & { archiveKey?: unknown };
    if (!entry || typeof document.archiveKey !== "string")
      throw new Error("DELETION_EXPORT_INVENTORY_MISMATCH");
    result.push(exportUnlink(entry, document.archiveKey));
  }
  if (result.length !== exports.size)
    throw new Error("DELETION_EXPORT_INVENTORY_MISMATCH");
  return result;
}

export function mediaDeletionUnlink(
  intent: MediaCleanupIntent,
): ManagedUnlinkLedgerEntry {
  return {
    entryType: "managed_unlink",
    namespace: intent.namespace,
    mediaId: intent.mediaId,
    checksum: intent.checksum,
    managedKey: intent.managedKey,
    bytes: null,
    state: "pending",
    attempts: 0,
    failureCode: null,
  };
}

export function deletionReportDetails(
  snapshot: DeletionInventorySnapshot,
  canceledJobIds: readonly string[],
): DeletionReportDetailLedgerEntry[] {
  const entries: DeletionReportDetailLedgerEntry[] = [];
  for (const entry of snapshot.inventoryEntries) {
    if (entry.entryType === "deletion_document")
      entries.push(detail("document", entry.documentId, entry.revisionHash));
    else if (entry.entryType === "deletion_export")
      entries.push(detail("managed_export", entry.exportId, entry.checksum));
    else if (entry.entryType === "deletion_media")
      entries.push(mediaDetail(entry));
  }
  for (const id of canceledJobIds)
    entries.push(detail("canceled_job", id, null));
  return entries.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function exportUnlink(
  entry: Extract<
    DeletionInventorySnapshot["inventoryEntries"][number],
    { entryType: "deletion_export" }
  >,
  archiveKey: string,
): ManagedUnlinkLedgerEntry {
  return {
    entryType: "managed_unlink",
    namespace: "export",
    mediaId: entry.exportId,
    checksum: entry.checksum,
    managedKey: archiveKey,
    bytes: entry.bytes,
    state: "pending",
    attempts: 0,
    failureCode: null,
  };
}

function mediaDetail(
  entry: Extract<
    DeletionInventorySnapshot["inventoryEntries"][number],
    { entryType: "deletion_media" }
  >,
): DeletionReportDetailLedgerEntry {
  const removed = entry.disposition === "unlink_pending";
  return detail(
    removed ? "removed_media" : "shared_media",
    removed ? entry.mediaId : hash(entry.mediaId),
    entry.checksum,
  );
}

function detail(
  category: DeletionReportDetailLedgerEntry["category"],
  itemId: string,
  checksum: string | null,
): DeletionReportDetailLedgerEntry {
  return { entryType: "deletion_report_detail", category, itemId, checksum };
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
