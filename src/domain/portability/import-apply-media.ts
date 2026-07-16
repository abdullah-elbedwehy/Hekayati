import { createHash } from "node:crypto";

import { ulid } from "ulid";

import {
  AssetStore,
  assetRecordSchema,
  type AssetRecord,
  type PreparedAsset,
} from "../../assets/asset-store.js";
import {
  OriginalAssetStore,
  originalAssetRecordSchema,
  type OriginalAssetRecord,
  type PreparedOriginalAsset,
} from "../../assets/original-asset-store.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import type { DocumentStore } from "../repository/document-store.js";
import type { CompiledImportPlan } from "./import-plan-compile.js";
import type { ImportPlanSourceBundle } from "./import-plan-selection.js";
import { canonicalImportMediaMetadata } from "./import-plan-target.js";
import { PreparedImportMediaRepository } from "./import-apply-storage.js";
import type { PreparedImportMedia } from "./import-apply-model.js";
import { assertPortabilityTransaction } from "./repositories.js";

export interface ImportApplyMediaInput {
  operationId: string;
  planId: string;
  source: Pick<ImportPlanSourceBundle, "documents" | "media">;
  compiled: Pick<
    CompiledImportPlan,
    "documents" | "preparedMedia" | "releases"
  >;
  readMedia(namespace: "asset" | "original", sourceId: string): Promise<Buffer>;
}

export interface ImportApplyMediaOptions {
  nowIso?: () => string;
  idFactory?: () => string;
}

type MediaDescriptor = AssetDescriptor | OriginalDescriptor;

interface DescriptorBase {
  sourceId: string;
  targetId: string;
  checksum: string;
  bytes: number;
  metadataHash: string;
  managedKey: string;
  wasPreexisting: boolean;
  references: number;
}

interface AssetDescriptor extends DescriptorBase {
  namespace: "asset";
  record: AssetRecord;
}

interface OriginalDescriptor extends DescriptorBase {
  namespace: "original";
  record: OriginalAssetRecord;
}

/**
 * Owns only import media preparation. Graph writes and action commits remain in
 * the caller's transaction so a crash exposes either zero or all new state.
 */
export class ImportApplyMediaCoordinator {
  readonly repository: PreparedImportMediaRepository;
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    private readonly assets: AssetStore,
    private readonly originals: OriginalAssetStore,
    options: ImportApplyMediaOptions = {},
  ) {
    this.repository = new PreparedImportMediaRepository(store);
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  async prepare(input: ImportApplyMediaInput): Promise<PreparedImportMedia[]> {
    const rows = this.repository.list(input.operationId);
    const descriptors = describeMedia(input, this.assets, this.originals, rows);
    assertExactRows(rows, input.planId, descriptors);
    for (const descriptor of descriptors) {
      const row = requireDescriptorRow(rows, descriptor);
      if (row.state === "discarded") fail("IMPORT_PREPARED_MEDIA_DISCARDED");
      if (row.state !== "committed") await this.write(input, row);
    }
    return this.repository.list(input.operationId);
  }

  reserveInTransaction(input: ImportApplyMediaInput): PreparedImportMedia[] {
    assertPortabilityTransaction(this.store);
    const existing = this.repository.list(input.operationId);
    const descriptors = describeMedia(
      input,
      this.assets,
      this.originals,
      existing,
    );
    if (existing.length > 0)
      return assertExactRows(existing, input.planId, descriptors);
    for (const descriptor of descriptors)
      this.repository.insertInTransaction(
        reservation(input, descriptor, this.idFactory(), this.nowIso()),
      );
    return this.repository.list(input.operationId);
  }

  commitInTransaction(input: ImportApplyMediaInput): PreparedImportMedia[] {
    assertPortabilityTransaction(this.store);
    const persisted = this.repository.list(input.operationId);
    const descriptors = describeMedia(
      input,
      this.assets,
      this.originals,
      persisted,
    );
    const rows = assertExactRows(persisted, input.planId, descriptors);
    if (rows.every((row) => row.state === "committed")) return rows;
    if (rows.some((row) => row.state !== "written"))
      fail("IMPORT_PREPARED_MEDIA_NOT_READY");
    for (const descriptor of descriptors) {
      const row = requireDescriptorRow(rows, descriptor);
      this.commitOne(row, descriptor);
    }
    return this.repository.list(input.operationId);
  }

  async discard(input: ImportApplyMediaInput): Promise<PreparedImportMedia[]> {
    const persisted = this.repository.list(input.operationId);
    const descriptors = describeMedia(
      input,
      this.assets,
      this.originals,
      persisted,
    );
    const rows = assertExactRows(persisted, input.planId, descriptors);
    if (rows.some((row) => row.state === "committed"))
      fail("IMPORT_PREPARED_MEDIA_ALREADY_COMMITTED");
    for (const descriptor of descriptors) {
      const current = this.repository.get(
        requireDescriptorRow(rows, descriptor).id,
      );
      if (!current || current.state === "discarded") continue;
      await this.discardOne(current, descriptor);
      this.transition(current, "discarded");
    }
    return this.repository.list(input.operationId);
  }

  private async write(
    input: ImportApplyMediaInput,
    reserved: PreparedImportMedia,
  ): Promise<void> {
    const bytes = await input.readMedia(reserved.namespace, reserved.sourceId);
    assertBytes(reserved, bytes);
    const prepared = await this.prepareOne(reserved, bytes);
    assertPreparedResult(reserved, prepared);
    assertHealthy(this.verifyPrepared(reserved));
    const current = this.repository.get(reserved.id);
    if (!current) fail("IMPORT_PREPARED_MEDIA_MISSING");
    if (current.state === "written") return;
    if (current.state !== "reserved") fail("IMPORT_PREPARED_MEDIA_NOT_READY");
    this.transition(current, "written");
  }

  private prepareOne(row: PreparedImportMedia, bytes: Buffer) {
    return row.namespace === "asset"
      ? this.assets.prepareImported({
          record: row.record,
          bytes,
          wasPreexisting: row.wasPreexisting,
        })
      : this.originals.prepareImported({
          record: row.record,
          bytes,
          wasPreexisting: row.wasPreexisting,
        });
  }

  private verifyPrepared(row: PreparedImportMedia) {
    return row.namespace === "asset"
      ? this.assets.verifyPreparedIntegritySync(preparedAsset(row))
      : this.originals.verifyPreparedIntegritySync(preparedOriginal(row));
  }

  private commitOne(
    row: PreparedImportMedia,
    descriptor: MediaDescriptor,
  ): void {
    assertHealthy(this.verifyPrepared(row));
    assertTargetBeforeCommit(row, this.assets, this.originals);
    if (row.namespace === "asset" && descriptor.namespace === "asset")
      this.assets.commitPreparedImported(
        preparedAsset(row),
        descriptor.references,
      );
    else if (
      row.namespace === "original" &&
      descriptor.namespace === "original"
    )
      this.originals.commitPreparedImported(
        preparedOriginal(row),
        descriptor.references,
      );
    else fail("IMPORT_PREPARED_MEDIA_DESCRIPTOR_MISMATCH");
    this.transition(row, "committed");
  }

  private async discardOne(
    row: PreparedImportMedia,
    descriptor: MediaDescriptor,
  ): Promise<void> {
    if (descriptor.wasPreexisting) return;
    assertFreshTargetAbsent(row, this.assets, this.originals);
    try {
      if (row.namespace === "asset")
        await this.assets.discardPrepared(preparedAsset(row));
      else await this.originals.discardPrepared(preparedOriginal(row));
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }

  private transition(
    current: PreparedImportMedia,
    state: "written" | "committed" | "discarded",
  ): PreparedImportMedia {
    const update = () =>
      this.repository.updateInTransaction(current, {
        ...current,
        state,
        revision: current.revision + 1,
        updatedAt: this.nowIso(),
      });
    return this.store.database.inTransaction
      ? update()
      : this.store.transactionImmediate(update);
  }
}

function describeMedia(
  input: ImportApplyMediaInput,
  assets: AssetStore,
  originals: OriginalAssetStore,
  pinnedRows: readonly PreparedImportMedia[] = [],
): MediaDescriptor[] {
  const releases = releaseIndex(input.compiled.releases);
  const seen = new Set<string>();
  const result = input.compiled.preparedMedia.map((intent) => {
    const key = mediaKey(intent.namespace, intent.sourceId);
    if (seen.has(key)) fail("IMPORT_PREPARED_MEDIA_INTENT_DUPLICATE");
    seen.add(key);
    const facts = requireFacts(input.source, intent.namespace, intent.sourceId);
    const sourceDocument = requireSourceMediaDocument(input.source, intent);
    assertIntentFacts(intent, facts, sourceDocument);
    const descriptor = descriptorForIntent(
      input,
      intent,
      facts,
      releases,
      assets,
      originals,
      pinnedRows,
    );
    return descriptor;
  });
  if (releases.size !== 0) fail("IMPORT_PREPARED_MEDIA_RELEASE_UNMATCHED");
  return result.sort(
    (left, right) =>
      left.namespace.localeCompare(right.namespace) ||
      left.sourceId.localeCompare(right.sourceId),
  );
}

function descriptorForIntent(
  input: ImportApplyMediaInput,
  intent: CompiledImportPlan["preparedMedia"][number],
  facts: ImportPlanSourceBundle["media"][number],
  releases: Map<string, CompiledImportPlan["releases"][number]>,
  assets: AssetStore,
  originals: OriginalAssetStore,
  pinnedRows: readonly PreparedImportMedia[],
): MediaDescriptor {
  const wasPreexisting = intent.disposition === "retain_existing";
  const record = wasPreexisting
    ? retainedRecord(intent, assets, originals, pinnedRows)
    : freshRecord(input.compiled.documents, intent);
  assertRecordMatchesIntent(record, intent, facts);
  const references = wasPreexisting
    ? retainedReferences(intent, facts, releases)
    : record.refCount;
  const base = {
    sourceId: intent.sourceId,
    targetId: intent.targetId,
    checksum: intent.sha256,
    bytes: intent.bytes,
    metadataHash: intent.metadataHash,
    managedKey: `${intent.sha256.slice(0, 2)}/${intent.sha256}.${record.extension}`,
    wasPreexisting,
    references,
  };
  return intent.namespace === "asset"
    ? { ...base, namespace: "asset", record: assetRecordSchema.parse(record) }
    : {
        ...base,
        namespace: "original",
        record: originalAssetRecordSchema.parse(record),
      };
}

function freshRecord(
  documents: CompiledImportPlan["documents"],
  intent: CompiledImportPlan["preparedMedia"][number],
): AssetRecord | OriginalAssetRecord {
  const collection = mediaCollection(intent.namespace);
  const matches = documents.filter(
    (item) =>
      item.collection === collection &&
      item.sourceId === intent.sourceId &&
      item.targetId === intent.targetId,
  );
  if (matches.length !== 1) fail("IMPORT_PREPARED_MEDIA_RECORD_MISSING");
  return intent.namespace === "asset"
    ? assetRecordSchema.parse(matches[0].document)
    : originalAssetRecordSchema.parse(matches[0].document);
}

function retainedRecord(
  intent: CompiledImportPlan["preparedMedia"][number],
  assets: AssetStore,
  originals: OriginalAssetStore,
  pinnedRows: readonly PreparedImportMedia[],
): AssetRecord | OriginalAssetRecord {
  const pinned = pinnedRows.find(
    (row) =>
      row.namespace === intent.namespace && row.sourceId === intent.sourceId,
  );
  if (pinned) return pinned.record;
  const record =
    intent.namespace === "asset"
      ? assets.get(intent.targetId)
      : originals.get(intent.targetId);
  if (!record) fail("IMPORT_PREPARED_MEDIA_TARGET_STALE");
  return record;
}

function retainedReferences(
  intent: CompiledImportPlan["preparedMedia"][number],
  facts: ImportPlanSourceBundle["media"][number],
  releases: Map<string, CompiledImportPlan["releases"][number]>,
): number {
  const key = mediaKey(intent.namespace, intent.targetId);
  const release = releases.get(key);
  if (
    !release ||
    release.entryType !== "reference_delta" ||
    release.disposition !== "retained" ||
    release.delta < 1 ||
    release.sha256 !== intent.sha256 ||
    release.bytes !== intent.bytes ||
    release.role !== facts.role
  )
    fail("IMPORT_PREPARED_MEDIA_RELEASE_MISMATCH");
  releases.delete(key);
  return release.delta;
}

function releaseIndex(
  entries: CompiledImportPlan["releases"],
): Map<string, CompiledImportPlan["releases"][number]> {
  const result = new Map<string, CompiledImportPlan["releases"][number]>();
  for (const entry of entries) {
    if (entry.entryType !== "reference_delta")
      fail("IMPORT_PREPARED_MEDIA_RELEASE_MISMATCH");
    const key = mediaKey(entry.namespace, entry.mediaId);
    if (result.has(key)) fail("IMPORT_PREPARED_MEDIA_RELEASE_DUPLICATE");
    result.set(key, entry);
  }
  return result;
}

function requireFacts(
  source: ImportApplyMediaInput["source"],
  namespace: "asset" | "original",
  id: string,
) {
  const matches = source.media.filter(
    (facts) => facts.namespace === namespace && facts.id === id,
  );
  if (matches.length !== 1) fail("IMPORT_PREPARED_MEDIA_SOURCE_FACTS_MISSING");
  return matches[0];
}

function requireSourceMediaDocument(
  source: ImportApplyMediaInput["source"],
  intent: CompiledImportPlan["preparedMedia"][number],
) {
  const collection = mediaCollection(intent.namespace);
  const matches = source.documents.filter(
    (item) => item.collection === collection && item.id === intent.sourceId,
  );
  if (matches.length !== 1) fail("IMPORT_PREPARED_MEDIA_SOURCE_RECORD_MISSING");
  return matches[0].document;
}

function assertIntentFacts(
  intent: CompiledImportPlan["preparedMedia"][number],
  facts: ImportPlanSourceBundle["media"][number],
  sourceDocument: ImportPlanSourceBundle["documents"][number]["document"],
): void {
  if (
    facts.bytes !== intent.bytes ||
    facts.sha256 !== intent.sha256 ||
    canonicalImportMediaMetadata({ facts, document: sourceDocument }) !==
      intent.metadataHash
  )
    fail("IMPORT_PREPARED_MEDIA_INTENT_MISMATCH");
}

function assertRecordMatchesIntent(
  record: AssetRecord | OriginalAssetRecord,
  intent: CompiledImportPlan["preparedMedia"][number],
  facts: ImportPlanSourceBundle["media"][number],
): void {
  if (
    record.id !== intent.targetId ||
    record.sha256 !== intent.sha256 ||
    record.bytes !== intent.bytes ||
    canonicalImportMediaMetadata({ facts, document: record }) !==
      intent.metadataHash
  )
    fail("IMPORT_PREPARED_MEDIA_RECORD_MISMATCH");
}

function reservation(
  input: ImportApplyMediaInput,
  descriptor: MediaDescriptor,
  id: string,
  now: string,
): PreparedImportMedia {
  return {
    id,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    operationId: input.operationId,
    planId: input.planId,
    namespace: descriptor.namespace,
    sourceId: descriptor.sourceId,
    targetId: descriptor.targetId,
    checksum: descriptor.checksum,
    bytes: descriptor.bytes,
    metadataHash: descriptor.metadataHash,
    managedKey: descriptor.managedKey,
    state: "reserved",
    wasPreexisting: descriptor.wasPreexisting,
    record: descriptor.record,
  } as PreparedImportMedia;
}

function assertExactRows(
  rows: readonly PreparedImportMedia[],
  planId: string,
  descriptors: readonly MediaDescriptor[],
): PreparedImportMedia[] {
  if (rows.length !== descriptors.length)
    fail("IMPORT_PREPARED_MEDIA_LEDGER_MISMATCH");
  for (const descriptor of descriptors) {
    const row = requireDescriptorRow(rows, descriptor);
    const rowJson = canonicalJson(rowIdentity(row));
    const descriptorJson = canonicalJson(descriptorIdentity(descriptor));
    if (row.planId !== planId || rowJson !== descriptorJson)
      fail("IMPORT_PREPARED_MEDIA_LEDGER_MISMATCH");
  }
  return [...rows];
}

function requireDescriptorRow(
  rows: readonly PreparedImportMedia[],
  descriptor: MediaDescriptor,
): PreparedImportMedia {
  const matches = rows.filter(
    (row) =>
      row.namespace === descriptor.namespace &&
      row.sourceId === descriptor.sourceId,
  );
  if (matches.length !== 1) fail("IMPORT_PREPARED_MEDIA_LEDGER_MISMATCH");
  return matches[0];
}

function rowIdentity(row: PreparedImportMedia) {
  return {
    namespace: row.namespace,
    sourceId: row.sourceId,
    targetId: row.targetId,
    checksum: row.checksum,
    bytes: row.bytes,
    metadataHash: row.metadataHash,
    managedKey: row.managedKey,
    wasPreexisting: row.wasPreexisting,
    record: row.record,
  };
}

function descriptorIdentity(descriptor: MediaDescriptor) {
  const { references: _references, ...identity } = descriptor;
  return identity;
}

function assertBytes(row: PreparedImportMedia, bytes: Buffer): void {
  if (
    bytes.byteLength !== row.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== row.checksum
  )
    fail("IMPORT_PREPARED_MEDIA_STAGED_BYTES_MISMATCH");
}

function assertPreparedResult(
  row: PreparedImportMedia,
  prepared: PreparedAsset | PreparedOriginalAsset,
): void {
  if (
    canonicalJson(prepared.record) !== canonicalJson(row.record) ||
    prepared.isNew === row.wasPreexisting
  )
    fail("IMPORT_PREPARED_MEDIA_WRITE_MISMATCH");
}

function assertHealthy(result: { status: string }): void {
  if (result.status !== "healthy")
    fail("IMPORT_PREPARED_MEDIA_INTEGRITY_FAILED");
}

function assertTargetBeforeCommit(
  row: PreparedImportMedia,
  assets: AssetStore,
  originals: OriginalAssetStore,
): void {
  const current =
    row.namespace === "asset"
      ? assets.get(row.targetId)
      : originals.get(row.targetId);
  if (row.wasPreexisting) {
    if (canonicalJson(current) !== canonicalJson(row.record))
      fail("IMPORT_PREPARED_MEDIA_TARGET_STALE");
  } else if (current !== null) fail("IMPORT_PREPARED_MEDIA_TARGET_STALE");
}

function assertFreshTargetAbsent(
  row: PreparedImportMedia,
  assets: AssetStore,
  originals: OriginalAssetStore,
): void {
  const current =
    row.namespace === "asset"
      ? assets.get(row.targetId)
      : originals.get(row.targetId);
  if (current) fail("IMPORT_PREPARED_MEDIA_ALREADY_COMMITTED");
}

function preparedAsset(row: PreparedImportMedia): PreparedAsset {
  if (row.namespace !== "asset")
    fail("IMPORT_PREPARED_MEDIA_NAMESPACE_INVALID");
  return { record: row.record, isNew: !row.wasPreexisting };
}

function preparedOriginal(row: PreparedImportMedia): PreparedOriginalAsset {
  if (row.namespace !== "original")
    fail("IMPORT_PREPARED_MEDIA_NAMESPACE_INVALID");
  return { record: row.record, isNew: !row.wasPreexisting };
}

function mediaCollection(namespace: "asset" | "original"): string {
  return namespace === "asset" ? "assets" : "original_assets";
}

function mediaKey(namespace: string, id: string): string {
  return `${namespace}:${id}`;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function fail(code: string): never {
  throw new Error(code);
}
