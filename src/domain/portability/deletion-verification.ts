import { createHash } from "node:crypto";

import type { ManagedDeletionCleanup } from "../../portability/deletion-cleanup.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import type { AssetStore } from "../../assets/asset-store.js";
import type { OriginalAssetStore } from "../../assets/original-asset-store.js";
import type {
  DeletionVerificationLedgerEntry,
  ManagedUnlinkLedgerEntry,
} from "./deletion-ledger.js";
import type { DeletionOperation } from "./deletion-model.js";
import type { PortabilityRegistry } from "./participants.js";
import type { DocumentStore } from "../repository/document-store.js";
import type { PortabilityLedgerEntry } from "./schemas.js";

interface DeletionVerificationInput {
  store: DocumentStore;
  registry: PortabilityRegistry;
  assets: AssetStore;
  originals: OriginalAssetStore;
  cleanup: ManagedDeletionCleanup;
  operation: DeletionOperation;
  inventoryEntries: readonly PortabilityLedgerEntry[];
  unlinks: readonly ManagedUnlinkLedgerEntry[];
}

export async function verifyDeletion(
  input: DeletionVerificationInput,
): Promise<DeletionVerificationLedgerEntry[]> {
  const results = await verifyInventoryEntries(input);
  results.push(
    ...(await verifyManagedUnlinks(input)),
    verifyTargetAbsent(input),
  );
  return results;
}

async function verifyInventoryEntries(
  input: DeletionVerificationInput,
): Promise<DeletionVerificationLedgerEntry[]> {
  const results: DeletionVerificationLedgerEntry[] = [];
  for (const entry of input.inventoryEntries) {
    if (entry.entryType === "deletion_document")
      results.push(
        verifyDocumentAbsent(
          input,
          entry.collection,
          entry.documentId,
          entry.revisionHash,
        ),
      );
    else if (entry.entryType === "deletion_job")
      results.push(
        verifyDocumentAbsent(input, "jobs", entry.jobId, entry.revisionHash),
      );
    else if (entry.entryType === "deletion_export")
      results.push(
        verifyDocumentAbsent(
          input,
          "managed_exports",
          entry.exportId,
          entry.checksum,
        ),
      );
    else if (entry.entryType === "deletion_preserved_document")
      results.push(verifyPreservedDocument(input, entry));
    else if (
      entry.entryType === "deletion_media" &&
      entry.disposition === "shared_reference_preserved"
    )
      results.push(await verifySharedMedia(input, entry));
  }
  return results;
}

async function verifyManagedUnlinks(
  input: DeletionVerificationInput,
): Promise<DeletionVerificationLedgerEntry[]> {
  const results: DeletionVerificationLedgerEntry[] = [];
  for (const unlink of input.unlinks) {
    const result = await input.cleanup.verify(unlink);
    results.push({
      entryType: "deletion_verification",
      checkKind:
        unlink.state === "preserved"
          ? "shared_media_preserved"
          : "managed_file_absent",
      subjectKind: unlink.namespace,
      subjectId: unlink.mediaId,
      expectedHash: unlink.checksum,
      expectedCount: 0,
      actualCount: result.passed ? 0 : 1,
      passed: result.passed,
      failureCode: result.failureCode,
    });
  }
  return results;
}

function verifyDocumentAbsent(
  input: DeletionVerificationInput,
  collection: string,
  id: string,
  expectedHash: string,
): DeletionVerificationLedgerEntry {
  const participant = input.registry.forCollection(collection);
  const query = participant.verifyDeleted(id);
  if (query.collection !== collection || query.id !== id)
    return verificationFailure(
      "document_absent",
      collection,
      id,
      expectedHash,
      0,
      1,
      "DELETION_PARTICIPANT_VERIFICATION_INVALID",
    );
  const exists = readDocument(input.store, collection, id) !== null;
  return exists
    ? verificationFailure(
        "document_absent",
        collection,
        id,
        expectedHash,
        0,
        1,
        "DELETION_DOCUMENT_STILL_PRESENT",
      )
    : verificationPass("document_absent", collection, id, expectedHash, 0, 0);
}

function verifyPreservedDocument(
  input: DeletionVerificationInput,
  entry: Extract<
    PortabilityLedgerEntry,
    { entryType: "deletion_preserved_document" }
  >,
): DeletionVerificationLedgerEntry {
  const current = readDocument(input.store, entry.collection, entry.documentId);
  const actual = current ? hash(current) : null;
  return actual === entry.revisionHash
    ? verificationPass(
        "preserved_document_unchanged",
        entry.collection,
        entry.documentId,
        entry.revisionHash,
        1,
        1,
      )
    : verificationFailure(
        "preserved_document_unchanged",
        entry.collection,
        entry.documentId,
        entry.revisionHash,
        1,
        current ? 1 : 0,
        "DELETION_PRESERVED_DOCUMENT_CHANGED",
      );
}

async function verifySharedMedia(
  input: DeletionVerificationInput,
  entry: Extract<PortabilityLedgerEntry, { entryType: "deletion_media" }>,
): Promise<DeletionVerificationLedgerEntry> {
  const record =
    entry.namespace === "asset"
      ? input.assets.get(entry.mediaId)
      : input.originals.get(entry.mediaId);
  let healthy = false;
  if (
    record &&
    record.sha256 === entry.checksum &&
    record.refCount === entry.expectedRemainingRefs
  ) {
    try {
      const bytes =
        entry.namespace === "asset"
          ? await input.assets.read(entry.mediaId)
          : await input.originals.read(entry.mediaId);
      healthy =
        createHash("sha256").update(bytes).digest("hex") === entry.checksum;
    } catch {
      healthy = false;
    }
  }
  return healthy
    ? verificationPass(
        "shared_media_preserved",
        entry.namespace,
        entry.mediaId,
        entry.checksum,
        entry.expectedRemainingRefs,
        record?.refCount ?? 0,
      )
    : verificationFailure(
        "shared_media_preserved",
        entry.namespace,
        entry.mediaId,
        entry.checksum,
        entry.expectedRemainingRefs,
        record?.refCount ?? 0,
        "DELETION_SHARED_MEDIA_VERIFICATION_FAILED",
      );
}

function verifyTargetAbsent(
  input: DeletionVerificationInput,
): DeletionVerificationLedgerEntry {
  const collection =
    input.operation.target.kind === "customer" ? "customers" : "projects";
  const exists =
    readDocument(input.store, collection, input.operation.target.id) !== null;
  return exists
    ? verificationFailure(
        "scope_absent",
        input.operation.target.kind,
        input.operation.target.id,
        input.operation.target.revisionHash,
        0,
        1,
        "DELETION_TARGET_STILL_PRESENT",
      )
    : verificationPass(
        "scope_absent",
        input.operation.target.kind,
        input.operation.target.id,
        input.operation.target.revisionHash,
        0,
        0,
      );
}

function readDocument(
  store: DocumentStore,
  collection: string,
  id: string,
): unknown {
  const row = store.database
    .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id) as { doc: string } | undefined;
  return row ? JSON.parse(row.doc) : null;
}

function verificationPass(
  checkKind: DeletionVerificationLedgerEntry["checkKind"],
  subjectKind: string,
  subjectId: string,
  expectedHash: string | null,
  expectedCount: number | null,
  actualCount: number | null,
): DeletionVerificationLedgerEntry {
  return {
    entryType: "deletion_verification",
    checkKind,
    subjectKind,
    subjectId,
    expectedHash,
    expectedCount,
    actualCount,
    passed: true,
    failureCode: null,
  };
}

function verificationFailure(
  checkKind: DeletionVerificationLedgerEntry["checkKind"],
  subjectKind: string,
  subjectId: string,
  expectedHash: string | null,
  expectedCount: number | null,
  actualCount: number | null,
  failureCode: string,
): DeletionVerificationLedgerEntry {
  return {
    entryType: "deletion_verification",
    checkKind,
    subjectKind,
    subjectId,
    expectedHash,
    expectedCount,
    actualCount,
    passed: false,
    failureCode,
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
