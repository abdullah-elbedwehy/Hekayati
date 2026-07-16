import { createHash } from "node:crypto";

import { ulid } from "ulid";

import type { AssetStore } from "../../assets/asset-store.js";
import type { MediaCleanupIntent } from "../../assets/media-reference.js";
import type { OriginalAssetStore } from "../../assets/original-asset-store.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import type { JobRecord } from "../../jobs/schemas.js";
import { JobRepository } from "../../jobs/repository.js";
import { projectSchema } from "../authoring/schemas.js";
import type {
  BaseDocument,
  DocumentStore,
} from "../repository/document-store.js";
import {
  exportDeletionUnlinks,
  mediaDeletionUnlink,
} from "./deletion-commit-model.js";
import {
  buildDeletionInventory,
  type DeletionInventorySnapshot,
} from "./deletion-inventory.js";
import {
  OperationJobCanceler,
  type ForcedJobCancellation,
} from "./deletion-jobs.js";
import type {
  DeletionMediaLedgerEntry,
  ManagedUnlinkLedgerEntry,
} from "./deletion-ledger.js";
import type { ImportPlan } from "./import-plan-model.js";
import { CapturedAttemptLedger } from "./operation-ledgers.js";
import type { PortabilityRegistry } from "./participants.js";
import {
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
  assertPortabilityTransaction,
} from "./repositories.js";
import { ScopeAdmissionService } from "./scope-locks.js";
import {
  portabilityLedgerEntrySchema,
  type PortabilityLedgerEntry,
  type PortabilityScope,
  type PortabilityScopeLock,
} from "./schemas.js";

const terminalJobStates = new Set(["succeeded", "failed", "canceled"]);

export interface ReplaceImportPlanEvidence {
  readonly mode: ImportPlan["mode"];
  readonly target: ImportPlan["target"];
  readonly source: Pick<ImportPlan["source"], "participantRegistryHash">;
}

export interface ReplaceParticipantStorage {
  deleteInTransaction(input: {
    operationId: string;
    collection: string;
    document: BaseDocument;
  }): void;
}

export interface ImportReplaceBoundaryOptions {
  store: DocumentStore;
  registry: PortabilityRegistry;
  assets: AssetStore;
  originals: OriginalAssetStore;
  nowIso?: () => string;
  idFactory?: () => string;
}

export interface PreparedReplaceLock {
  readonly lock: PortabilityScopeLock;
  readonly targetSnapshotHash: string;
}

export type ReplaceImportLockEvidence = Pick<
  PortabilityScopeLock,
  "id" | "mode" | "phase" | "revision" | "scope"
>;

export interface FinalizedReplaceBoundary {
  readonly lockExclusive: PortabilityScopeLock;
  readonly canceledJobIds: readonly string[];
  readonly unlinks: readonly ManagedUnlinkLedgerEntry[];
  readonly sharedMedia: readonly DeletionMediaLedgerEntry[];
  readonly deletedDocumentCount: number;
}

interface RetainedMediaDelta {
  readonly namespace: "asset" | "original";
  readonly mediaId: string;
  readonly checksum: string;
  readonly bytes: number;
  readonly role: string;
  readonly delta: number;
}

interface MediaCommitBaseline extends RetainedMediaDelta {
  readonly beforeRefCount: number;
}

/**
 * Owns only the destructive half of replace-existing import. The caller keeps
 * both methods inside its operation/action transactions and inserts the new
 * graph after `finalizeInTransaction` returns.
 */
export class ImportReplaceBoundary {
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;
  private readonly jobs: JobRepository;
  private readonly ledgers: PortabilityLedgerRepository;
  private readonly lockRepository: PortabilityScopeLockRepository;
  private readonly locks: ScopeAdmissionService;
  private readonly canceler: OperationJobCanceler;

  constructor(private readonly options: ImportReplaceBoundaryOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.jobs = new JobRepository(options.store);
    this.ledgers = new PortabilityLedgerRepository(options.store);
    this.lockRepository = new PortabilityScopeLockRepository(options.store);
    this.locks = new ScopeAdmissionService(
      options.store,
      this.lockRepository,
      this.ledgers,
      { nowIso: this.nowIso, idFactory: this.idFactory },
    );
    this.canceler = new OperationJobCanceler(options.store);
  }

  prepareLockInTransaction(input: {
    operationId: string;
    plan: ReplaceImportPlanEvidence;
  }): PreparedReplaceLock {
    assertPortabilityTransaction(this.options.store);
    const target = this.requireTarget(input.plan);
    const snapshot = this.freshSnapshot(input.plan, target.projectId);
    const captured = new CapturedAttemptLedger(
      this.options.store,
      this.ledgers,
      { nowIso: this.nowIso, idFactory: this.idFactory },
    ).writeInTransaction(input.operationId, this.capturedAttempts(snapshot));
    const scope = replaceScope(target.projectId, target.customerId);
    const lock = this.locks.acquireManyInTransaction([
      {
        operationId: input.operationId,
        scope,
        mode: "replace_import",
        phase: "draining",
        capturedAttemptLedgerRoot: captured.rootHash,
        capturedAttemptCount: captured.entryCount,
      },
    ])[0];
    return Object.freeze({
      lock,
      targetSnapshotHash: replaceTargetSnapshotHash(snapshot),
    });
  }

  finalizeInTransaction(input: {
    operationId: string;
    plan: ReplaceImportPlanEvidence;
    lock: ReplaceImportLockEvidence;
    targetSnapshotHash: string;
    storage: ReplaceParticipantStorage;
    retainedMediaDeltas?: readonly PortabilityLedgerEntry[];
    commitImportedMediaInTransaction?: () => void;
  }): FinalizedReplaceBoundary {
    assertPortabilityTransaction(this.options.store);
    const target = this.requireTarget(input.plan);
    const scope = replaceScope(target.projectId, target.customerId);
    const draining = this.requireDrainingLock(
      input.operationId,
      input.lock,
      scope,
    );
    const replacement = this.cancelAndFreezeCurrentGraph(
      input,
      scope,
      draining,
      target.projectId,
    );
    const retained = this.commitImportedMedia(input, replacement.current);
    const media = this.releaseMedia(
      replacement.current.inventoryEntries,
      retained,
    );
    const unlinks = [
      ...media.unlinks,
      ...exportDeletionUnlinks(replacement.current),
    ].sort(compareUnlinks);
    this.deleteCurrentGraph(
      input.operationId,
      input.storage,
      replacement.current,
      replacement.cancellation.currentJobs,
    );
    return Object.freeze({
      lockExclusive: replacement.lockExclusive,
      canceledJobIds: replacement.cancellation.canceledJobIds,
      unlinks: Object.freeze(unlinks),
      sharedMedia: Object.freeze(media.shared),
      deletedDocumentCount: replacement.current.deleteOrder.length,
    });
  }

  private deleteCurrentGraph(
    operationId: string,
    storage: ReplaceParticipantStorage,
    current: DeletionInventorySnapshot,
    currentJobs: ReadonlyMap<string, JobRecord>,
  ): void {
    for (const item of current.deleteOrder) {
      const document =
        item.collection === "jobs"
          ? (currentJobs.get(item.id) ?? item.document)
          : item.document;
      storage.deleteInTransaction({
        operationId,
        collection: item.collection,
        document,
      });
    }
  }

  private commitImportedMedia(
    input: {
      retainedMediaDeltas?: readonly PortabilityLedgerEntry[];
      commitImportedMediaInTransaction?: () => void;
    },
    current: DeletionInventorySnapshot,
  ): ReadonlyMap<string, RetainedMediaDelta> {
    const hasCallback = input.commitImportedMediaInTransaction !== undefined;
    const hasEvidence = input.retainedMediaDeltas !== undefined;
    if (hasCallback !== hasEvidence)
      fail("IMPORT_REPLACE_MEDIA_COMMIT_EVIDENCE_REQUIRED");
    const retained = normalizeRetainedMediaDeltas(
      input.retainedMediaDeltas ?? [],
    );
    const baselines = this.mediaCommitBaselines(current, retained);
    input.commitImportedMediaInTransaction?.();
    this.assertImportedMediaCommit(baselines);
    return retained;
  }

  private cancelAndFreezeCurrentGraph(
    input: {
      operationId: string;
      plan: ReplaceImportPlanEvidence;
      targetSnapshotHash: string;
    },
    scope: Extract<PortabilityScope, { kind: "project" }>,
    draining: PortabilityScopeLock,
    projectId: string,
  ): {
    cancellation: ForcedJobCancellation;
    lockExclusive: PortabilityScopeLock;
    current: DeletionInventorySnapshot;
  } {
    const beforeCancellation = this.freshSnapshot(input.plan, projectId);
    if (
      replaceTargetSnapshotHash(beforeCancellation) !== input.targetSnapshotHash
    )
      fail("IMPORT_REPLACE_TARGET_STALE");
    const cancellation = this.canceler.forceCancelInTransaction({
      operationId: input.operationId,
      scope,
      expected: beforeCancellation.inventoryEntries
        .filter(isDeletionJob)
        .map((entry) => ({
          jobId: entry.jobId,
          revision: entry.revision,
          revisionHash: entry.revisionHash,
        })),
      nowIso: this.nowIso(),
      context: {
        mode: "replace_import",
        phase: "draining",
        reason: "replace_import",
      },
    });
    const lockExclusive = this.locks.transitionInTransaction(
      draining.id,
      input.operationId,
      draining.revision,
      "exclusive",
    );
    const current = this.freshSnapshot(input.plan, projectId);
    if (replaceTargetSnapshotHash(current) !== input.targetSnapshotHash)
      fail("IMPORT_REPLACE_TARGET_STALE");
    return { cancellation, lockExclusive, current };
  }

  private requireTarget(plan: ReplaceImportPlanEvidence): {
    projectId: string;
    customerId: string;
  } {
    if (
      plan.mode !== "replace_existing" ||
      plan.target.kind !== "replace_project" ||
      plan.target.projectId === null ||
      plan.target.customerId === null ||
      plan.target.projectRevision === null ||
      plan.target.projectRevisionHash === null
    )
      fail("IMPORT_REPLACE_PLAN_REQUIRED");
    if (plan.source.participantRegistryHash !== this.options.registry.hash)
      fail("IMPORT_REPLACE_REGISTRY_MISMATCH");
    const project = this.readProject(plan.target.projectId);
    if (
      project.customerId !== plan.target.customerId ||
      project.revision !== plan.target.projectRevision ||
      hash(project) !== plan.target.projectRevisionHash
    )
      fail("IMPORT_REPLACE_TARGET_STALE");
    return {
      projectId: plan.target.projectId,
      customerId: plan.target.customerId,
    };
  }

  private freshSnapshot(
    plan: ReplaceImportPlanEvidence,
    projectId: string,
  ): DeletionInventorySnapshot {
    const snapshot = buildDeletionInventory({
      store: this.options.store,
      registry: this.options.registry,
      target: { kind: "project", id: projectId },
      nowIso: this.nowIso(),
    });
    if (
      snapshot.inventory.target.customerId !== plan.target.customerId ||
      snapshot.inventory.target.revisionHash !== plan.target.projectRevisionHash
    )
      fail("IMPORT_REPLACE_TARGET_STALE");
    if (snapshot.inventory.counts.blockers > 0)
      fail("IMPORT_REPLACE_BLOCKERS_PRESENT");
    return snapshot;
  }

  private capturedAttempts(
    snapshot: DeletionInventorySnapshot,
  ): readonly { jobId: string; attempt: number }[] {
    return snapshot.inventoryEntries
      .filter(isDeletionJob)
      .map((entry) => this.jobs.get(entry.jobId))
      .filter((job): job is JobRecord => Boolean(job))
      .filter((job) => !terminalJobStates.has(job.state) && job.attempts > 0)
      .map((job) => ({ jobId: job.id, attempt: job.attempts }));
  }

  private requireDrainingLock(
    operationId: string,
    expected: ReplaceImportLockEvidence,
    scope: Extract<PortabilityScope, { kind: "project" }>,
  ): PortabilityScopeLock {
    const current = this.lockRepository.get(expected.id);
    if (
      !current ||
      current.operationId !== operationId ||
      current.id !== expected.id ||
      current.mode !== expected.mode ||
      current.phase !== expected.phase ||
      current.revision !== expected.revision ||
      canonicalJson(current.scope) !== canonicalJson(expected.scope) ||
      current.mode !== "replace_import" ||
      current.phase !== "draining" ||
      current.scope.kind !== "project" ||
      current.scope.id !== scope.id ||
      current.scope.customerId !== scope.customerId
    )
      fail("IMPORT_REPLACE_LOCK_STALE");
    return current;
  }

  private releaseMedia(
    entries: readonly PortabilityLedgerEntry[],
    retained: ReadonlyMap<string, RetainedMediaDelta>,
  ): {
    unlinks: ManagedUnlinkLedgerEntry[];
    shared: DeletionMediaLedgerEntry[];
  } {
    const unlinks: ManagedUnlinkLedgerEntry[] = [];
    const shared: DeletionMediaLedgerEntry[] = [];
    for (const entry of entries.filter(isDeletionMedia)) {
      const importedDelta = retained.get(mediaKey(entry))?.delta ?? 0;
      const cleanup = this.releaseMediaEntry(entry, importedDelta);
      if (cleanup) unlinks.push(mediaDeletionUnlink(cleanup));
      else shared.push(preservedMediaEntry(entry, importedDelta));
    }
    return { unlinks, shared };
  }

  private releaseMediaEntry(
    entry: DeletionMediaLedgerEntry,
    importedDelta: number,
  ): MediaCleanupIntent | null {
    let cleanup: MediaCleanupIntent | null = null;
    for (let count = 0; count < entry.ownedRefs; count += 1) {
      const released =
        entry.namespace === "asset"
          ? this.options.assets.releaseWithoutUnlinkInTransaction(entry.mediaId)
          : this.options.originals.releaseWithoutUnlinkInTransaction(
              entry.mediaId,
            );
      if (released.cleanupIntent) {
        if (cleanup) fail("IMPORT_REPLACE_MEDIA_CLEANUP_DUPLICATE");
        cleanup = released.cleanupIntent;
      }
    }
    const current =
      entry.namespace === "asset"
        ? this.options.assets.get(entry.mediaId)
        : this.options.originals.get(entry.mediaId);
    const expectedFinalRefs = entry.expectedRemainingRefs + importedDelta;
    if (expectedFinalRefs === 0) {
      if (current || !cleanup) fail("IMPORT_REPLACE_MEDIA_RELEASE_MISMATCH");
    } else if (
      !current ||
      current.sha256 !== entry.checksum ||
      current.refCount !== expectedFinalRefs ||
      cleanup
    ) {
      fail("IMPORT_REPLACE_MEDIA_RELEASE_MISMATCH");
    }
    return cleanup;
  }

  private mediaCommitBaselines(
    snapshot: DeletionInventorySnapshot,
    retained: ReadonlyMap<string, RetainedMediaDelta>,
  ): MediaCommitBaseline[] {
    const expected = new Map<string, RetainedMediaDelta>();
    for (const entry of snapshot.inventoryEntries.filter(isDeletionMedia)) {
      const oldRecord = this.requireMediaRecord(entry.namespace, entry.mediaId);
      if (
        oldRecord.sha256 !== entry.checksum ||
        oldRecord.refCount !== entry.totalRefs
      )
        fail("IMPORT_REPLACE_MEDIA_DELTA_MISMATCH");
      expected.set(mediaKey(entry), {
        namespace: entry.namespace,
        mediaId: entry.mediaId,
        checksum: entry.checksum,
        bytes: oldRecord.bytes,
        role:
          retained.get(mediaKey(entry))?.role ??
          (entry.namespace === "asset" && "role" in oldRecord
            ? oldRecord.role
            : "original"),
        delta: retained.get(mediaKey(entry))?.delta ?? 0,
      });
    }
    for (const [key, delta] of retained) expected.set(key, delta);
    return [...expected.values()].map((entry) => {
      const record = this.requireCompatibleMediaRecord(entry);
      return { ...entry, beforeRefCount: record.refCount };
    });
  }

  private assertImportedMediaCommit(
    baselines: readonly MediaCommitBaseline[],
  ): void {
    for (const baseline of baselines) {
      const current = this.requireCompatibleMediaRecord(baseline);
      if (current.refCount !== baseline.beforeRefCount + baseline.delta)
        fail("IMPORT_REPLACE_MEDIA_COMMIT_MISMATCH");
    }
  }

  private requireCompatibleMediaRecord(entry: RetainedMediaDelta) {
    const record = this.requireMediaRecord(entry.namespace, entry.mediaId);
    if (
      record.sha256 !== entry.checksum ||
      record.bytes !== entry.bytes ||
      (entry.namespace === "asset" &&
        (!("role" in record) || record.role !== entry.role))
    )
      fail("IMPORT_REPLACE_MEDIA_DELTA_MISMATCH");
    return record;
  }

  private requireMediaRecord(namespace: "asset" | "original", id: string) {
    const record =
      namespace === "asset"
        ? this.options.assets.get(id)
        : this.options.originals.get(id);
    if (!record) fail("IMPORT_REPLACE_MEDIA_DELTA_MISMATCH");
    return record;
  }

  private readProject(id: string) {
    const row = this.options.store.database
      .prepare(
        "SELECT doc FROM documents WHERE collection = 'projects' AND id = ?",
      )
      .get(id) as { doc: string } | undefined;
    if (!row) fail("IMPORT_REPLACE_TARGET_STALE");
    return projectSchema.parse(JSON.parse(row.doc));
  }
}

export function replaceTargetSnapshotHash(
  snapshot: DeletionInventorySnapshot,
): string {
  const graph = snapshot.inventoryEntries
    .filter((entry) => entry.entryType !== "deletion_job")
    .sort(compareEntries);
  const jobIds = snapshot.inventoryEntries
    .filter(isDeletionJob)
    .map((entry) => entry.jobId)
    .sort((left, right) => left.localeCompare(right));
  return hash({
    contract: "HekayatiReplaceTargetSnapshot/v1",
    participantRegistryHash: snapshot.inventory.participantRegistryHash,
    target: snapshot.inventory.target,
    graph,
    jobIds,
    blockers: [...snapshot.blockerEntries].sort(compareEntries),
    deleteOrder: snapshot.deleteOrder.map((item) => ({
      collection: item.collection,
      id: item.id,
    })),
  });
}

function replaceScope(
  projectId: string,
  customerId: string,
): Extract<PortabilityScope, { kind: "project" }> {
  return {
    kind: "project",
    id: projectId,
    projectId,
    customerId,
  };
}

function isDeletionJob(
  entry: PortabilityLedgerEntry,
): entry is Extract<PortabilityLedgerEntry, { entryType: "deletion_job" }> {
  return entry.entryType === "deletion_job";
}

function isDeletionMedia(
  entry: PortabilityLedgerEntry,
): entry is DeletionMediaLedgerEntry {
  return entry.entryType === "deletion_media";
}

function compareEntries(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function compareUnlinks(
  left: ManagedUnlinkLedgerEntry,
  right: ManagedUnlinkLedgerEntry,
): number {
  return (
    left.namespace.localeCompare(right.namespace) ||
    left.mediaId.localeCompare(right.mediaId)
  );
}

function preservedMediaEntry(
  entry: DeletionMediaLedgerEntry,
  importedDelta: number,
): DeletionMediaLedgerEntry {
  const expectedRemainingRefs = entry.expectedRemainingRefs + importedDelta;
  if (expectedRemainingRefs < 1) fail("IMPORT_REPLACE_MEDIA_RELEASE_MISMATCH");
  return {
    ...entry,
    totalRefs: entry.totalRefs + importedDelta,
    expectedRemainingRefs,
    disposition: "shared_reference_preserved",
  };
}

function normalizeRetainedMediaDeltas(
  values: readonly PortabilityLedgerEntry[],
): ReadonlyMap<string, RetainedMediaDelta> {
  const result = new Map<string, RetainedMediaDelta>();
  for (const value of values) {
    const entry = portabilityLedgerEntrySchema.parse(value);
    if (
      entry.entryType !== "reference_delta" ||
      entry.disposition !== "retained" ||
      (entry.namespace !== "asset" && entry.namespace !== "original") ||
      entry.delta <= 0
    )
      fail("IMPORT_REPLACE_MEDIA_DELTA_INVALID");
    const next: RetainedMediaDelta = {
      namespace: entry.namespace,
      mediaId: entry.mediaId,
      checksum: entry.sha256,
      bytes: entry.bytes,
      role: entry.role,
      delta: entry.delta,
    };
    const key = mediaKey(next);
    const existing = result.get(key);
    if (!existing) {
      result.set(key, next);
      continue;
    }
    if (
      existing.checksum !== next.checksum ||
      existing.bytes !== next.bytes ||
      existing.role !== next.role
    )
      fail("IMPORT_REPLACE_MEDIA_DELTA_MISMATCH");
    const delta = existing.delta + next.delta;
    if (!Number.isSafeInteger(delta) || delta > 1_000_000)
      fail("IMPORT_REPLACE_MEDIA_DELTA_INVALID");
    result.set(key, { ...existing, delta });
  }
  return result;
}

function mediaKey(entry: {
  namespace: "asset" | "original";
  mediaId: string;
}): string {
  return `${entry.namespace}:${entry.mediaId}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function fail(code: string): never {
  throw new Error(code);
}
