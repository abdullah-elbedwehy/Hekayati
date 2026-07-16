import { ulid } from "ulid";

import type { AssetStore } from "../../assets/asset-store.js";
import type { MediaCleanupIntent } from "../../assets/media-reference.js";
import type { OriginalAssetStore } from "../../assets/original-asset-store.js";
import type { ManagedDeletionCleanup } from "../../portability/deletion-cleanup.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import { JobRepository } from "../../jobs/repository.js";
import type { JobRecord } from "../../jobs/schemas.js";
import type { DocumentStore } from "../repository/document-store.js";
import {
  assertDeletionConfirmationTarget,
  deletionActionOperationId,
  deletionCleanupBoundaryInput,
  deletionConfirmBoundaryInput,
  deletionTargetScope,
  inlineDeletionOperationResult,
} from "./deletion-actions.js";
import {
  createInitialDeletionOperation,
  createVerifiedDeletionReport,
  deletionReportDetails,
  exportDeletionUnlinks,
  mediaDeletionUnlink,
} from "./deletion-commit-model.js";
import {
  appendDeletionLedgerPages,
  assertDeletionLedgerRoot,
  latestManagedUnlinks,
} from "./deletion-ledger-pages.js";
import type {
  DeletionMediaLedgerEntry,
  ManagedUnlinkLedgerEntry,
} from "./deletion-ledger.js";
import {
  buildDeletionInventory,
  persistDeletionInventoryPages,
  type DeletionInventorySnapshot,
} from "./deletion-inventory.js";
import { DeletionJobCanceler } from "./deletion-jobs.js";
import {
  deletionOperationSchema,
  type DeletionInventory,
  type DeletionOperation,
  type DeletionReport,
  type DeletionTargetKind,
} from "./deletion-model.js";
import {
  DeletionInventoryRepository,
  DeletionOperationRepository,
  DeletionReportRepository,
  ParticipantDeletionStorage,
} from "./deletion-storage.js";
import { verifyDeletion } from "./deletion-verification.js";
import {
  CapturedAttemptLedger,
  PortabilityActionBoundary,
} from "./operation-ledgers.js";
import type { PortabilityRegistry } from "./participants.js";
import {
  PortabilityActionRepository,
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
} from "./repositories.js";
import { ScopeAdmissionService } from "./scope-locks.js";
import type { PortabilityLedgerEntry } from "./schemas.js";

const terminalJobStates = new Set(["succeeded", "failed", "canceled"]);
const maximumCleanupAttempts = 32;

export interface DeletionServiceHooks {
  beforeGraphCommit?(): void;
  afterFilesystemBatch?(): void;
}

export interface DeletionServiceOptions {
  store: DocumentStore;
  registry: PortabilityRegistry;
  assets: AssetStore;
  originals: OriginalAssetStore;
  cleanup: ManagedDeletionCleanup;
  nowIso?: () => string;
  idFactory?: () => string;
  hooks?: DeletionServiceHooks;
}

export interface DeletionConfirmationResult {
  operation: DeletionOperation;
  report: DeletionReport | null;
  replayed: boolean;
}

export class DeletionService {
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;
  private readonly inventories: DeletionInventoryRepository;
  private readonly operations: DeletionOperationRepository;
  private readonly reports: DeletionReportRepository;
  private readonly actions: PortabilityActionBoundary;
  private readonly ledgers: PortabilityLedgerRepository;
  private readonly locks: ScopeAdmissionService;
  private readonly lockRepository: PortabilityScopeLockRepository;
  private readonly jobs: JobRepository;
  private readonly canceler: DeletionJobCanceler;
  private readonly deletionStorage: ParticipantDeletionStorage;

  constructor(private readonly options: DeletionServiceOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.inventories = new DeletionInventoryRepository(options.store);
    this.operations = new DeletionOperationRepository(options.store);
    this.reports = new DeletionReportRepository(options.store);
    this.ledgers = new PortabilityLedgerRepository(options.store);
    this.lockRepository = new PortabilityScopeLockRepository(options.store);
    this.actions = new PortabilityActionBoundary(
      options.store,
      new PortabilityActionRepository(options.store),
      { nowIso: this.nowIso, idFactory: this.idFactory },
    );
    this.locks = new ScopeAdmissionService(
      options.store,
      this.lockRepository,
      this.ledgers,
      { nowIso: this.nowIso, idFactory: this.idFactory },
    );
    this.jobs = new JobRepository(options.store);
    this.canceler = new DeletionJobCanceler(options.store);
    this.deletionStorage = new ParticipantDeletionStorage(
      options.store,
      options.registry,
    );
  }

  createInventory(target: {
    kind: DeletionTargetKind;
    id: string;
  }): DeletionInventorySnapshot {
    return this.options.store.transactionImmediate(() => {
      const snapshot = buildDeletionInventory({
        store: this.options.store,
        registry: this.options.registry,
        target,
        nowIso: this.nowIso(),
      });
      persistDeletionInventoryPages({
        store: this.options.store,
        repository: this.ledgers,
        snapshot,
        nowIso: snapshot.inventory.createdAt,
        idFactory: this.idFactory,
      });
      this.inventories.insertInTransaction(snapshot.inventory);
      return snapshot;
    });
  }

  async confirm(input: {
    target: { kind: DeletionTargetKind; id: string };
    inventoryId: string;
    inventoryHash: string;
    targetRevisionHash: string;
    displayName: string;
    finalConfirmation: boolean;
    customerCharacterDecision: "not_applicable" | "cascade" | "keep_pinned";
    idempotencyKey: string;
  }): Promise<DeletionConfirmationResult> {
    const inventory = this.requireInventory(input.inventoryId);
    assertDeletionConfirmationTarget(input, inventory);
    const boundary = deletionConfirmBoundaryInput(
      input.idempotencyKey,
      inventory,
      input.customerCharacterDecision,
    );
    const result = this.actions.run(boundary, (identity) =>
      this.commitDeletion(identity.id, identity.recordedAt, inventory),
    );
    const operationId = deletionActionOperationId(result.action.result);
    const operation = await this.advanceCleanup(operationId);
    return {
      operation,
      report: this.reports.get(operationId),
      replayed: result.replayed,
    };
  }

  async retryCleanup(input: {
    operationId: string;
    idempotencyKey: string;
  }): Promise<DeletionConfirmationResult> {
    const operation = this.requireOperation(input.operationId);
    const boundary = deletionCleanupBoundaryInput(
      input.idempotencyKey,
      operation,
    );
    const result = this.actions.run(boundary, () =>
      inlineDeletionOperationResult(operation),
    );
    const current = await this.advanceCleanup(
      deletionActionOperationId(result.action.result),
    );
    return {
      operation: current,
      report: this.reports.get(current.id),
      replayed: result.replayed,
    };
  }

  async recover(): Promise<DeletionOperation[]> {
    const recovered: DeletionOperation[] = [];
    for (const operation of this.operations.listRecoverable()) {
      try {
        recovered.push(await this.advanceCleanup(operation.id));
      } catch {
        recovered.push(this.requireOperation(operation.id));
      }
    }
    return recovered;
  }

  operation(id: string): DeletionOperation | null {
    return this.operations.get(id);
  }

  report(id: string): DeletionReport | null {
    return this.reports.get(id);
  }

  private commitDeletion(
    operationId: string,
    recordedAt: string,
    inventory: DeletionInventory,
  ) {
    const fresh = this.freshInventory(inventory);
    const locked = this.acquireDeletionLock(
      operationId,
      recordedAt,
      inventory,
      fresh,
    );
    const media = this.releaseMedia(fresh.inventoryEntries);
    const unlinks = [...media.unlinks, ...exportDeletionUnlinks(fresh)].sort(
      compareUnlinks,
    );
    this.deleteParticipantGraph(
      operationId,
      fresh,
      locked.cancellation.currentJobs,
    );
    this.options.hooks?.beforeGraphCommit?.();
    const operation = this.persistCommittedDeletion({
      operationId,
      recordedAt,
      inventory,
      fresh,
      unlinks,
      shared: media.shared,
      lockId: locked.exclusive.id,
      lockRevision: locked.exclusive.revision,
      canceledJobIds: locked.cancellation.canceledJobIds,
    });
    return inlineDeletionOperationResult(operation);
  }

  private acquireDeletionLock(
    operationId: string,
    recordedAt: string,
    inventory: DeletionInventory,
    fresh: DeletionInventorySnapshot,
  ) {
    const captured = this.captureAttempts(operationId, fresh);
    const scope = deletionTargetScope(inventory);
    const draining = this.locks.acquireManyInTransaction([
      {
        operationId,
        scope,
        mode: "permanent_delete",
        phase: "draining",
        capturedAttemptLedgerRoot: captured.rootHash,
        capturedAttemptCount: captured.entryCount,
      },
    ])[0];
    const cancellation = this.canceler.forceCancelInTransaction({
      operationId,
      scope,
      expected: fresh.inventoryEntries.filter(isDeletionJob).map((entry) => ({
        jobId: entry.jobId,
        revision: entry.revision,
        revisionHash: entry.revisionHash,
      })),
      nowIso: recordedAt,
    });
    const exclusive = this.locks.transitionInTransaction(
      draining.id,
      operationId,
      draining.revision,
      "exclusive",
    );
    return { cancellation, exclusive };
  }

  private persistCommittedDeletion(input: {
    operationId: string;
    recordedAt: string;
    inventory: DeletionInventory;
    fresh: DeletionInventorySnapshot;
    unlinks: readonly ManagedUnlinkLedgerEntry[];
    shared: readonly DeletionMediaLedgerEntry[];
    lockId: string;
    lockRevision: number;
    canceledJobIds: readonly string[];
  }): DeletionOperation {
    const { operationId, recordedAt } = input;
    const unlinkRoot = this.appendLedger(
      operationId,
      "deletion_unlinks",
      input.unlinks,
      recordedAt,
    );
    const sharedRoot = this.appendLedger(
      operationId,
      "shared_preservation",
      input.shared,
      recordedAt,
    );
    const reportRoot = this.appendLedger(
      operationId,
      "report_detail",
      deletionReportDetails(input.fresh, input.canceledJobIds),
      recordedAt,
    );
    const verificationRoot = this.ledgers.root(
      operationId,
      "deletion_verification",
    );
    const operation = createInitialDeletionOperation({
      operationId,
      recordedAt,
      inventory: input.inventory,
      lockId: input.lockId,
      lockRevision: input.lockRevision,
      canceledJobs: input.canceledJobIds.length,
      unlinkItems: input.unlinks.length,
      unlinkRoot: unlinkRoot.rootHash,
      sharedRoot: sharedRoot.rootHash,
      verificationRoot: verificationRoot.rootHash,
      reportRoot: reportRoot.rootHash,
    });
    this.operations.insertInTransaction(operation);
    return operation;
  }

  private freshInventory(
    persisted: DeletionInventory,
  ): DeletionInventorySnapshot {
    assertDeletionLedgerRoot(
      this.ledgers,
      persisted.id,
      "deletion_inventory",
      persisted.inventoryLedgerRoot,
    );
    assertDeletionLedgerRoot(
      this.ledgers,
      persisted.id,
      "deletion_blockers",
      persisted.blockerLedgerRoot,
    );
    const fresh = buildDeletionInventory({
      store: this.options.store,
      registry: this.options.registry,
      target: { kind: persisted.target.kind, id: persisted.target.id },
      nowIso: persisted.createdAt,
    });
    if (canonicalJson(fresh.inventory) !== canonicalJson(persisted))
      throw new Error("DELETION_INVENTORY_STALE");
    if (persisted.counts.blockers > 0)
      throw new Error("DELETION_BLOCKERS_PRESENT");
    return fresh;
  }

  private captureAttempts(
    operationId: string,
    fresh: DeletionInventorySnapshot,
  ) {
    const attempts = fresh.inventoryEntries
      .filter(isDeletionJob)
      .map((entry) => this.jobs.get(entry.jobId))
      .filter((job): job is JobRecord => Boolean(job))
      .filter((job) => !terminalJobStates.has(job.state) && job.attempts > 0)
      .map((job) => ({ jobId: job.id, attempt: job.attempts }));
    return new CapturedAttemptLedger(this.options.store, this.ledgers, {
      nowIso: this.nowIso,
      idFactory: this.idFactory,
    }).writeInTransaction(operationId, attempts);
  }

  private releaseMedia(entries: readonly PortabilityLedgerEntry[]): {
    unlinks: ManagedUnlinkLedgerEntry[];
    shared: DeletionMediaLedgerEntry[];
  } {
    const unlinks: ManagedUnlinkLedgerEntry[] = [];
    const shared: DeletionMediaLedgerEntry[] = [];
    for (const entry of entries.filter(isDeletionMedia)) {
      const cleanup = this.releaseMediaEntry(entry);
      if (cleanup) unlinks.push(mediaDeletionUnlink(cleanup));
      else shared.push(entry);
    }
    return { unlinks, shared };
  }

  private releaseMediaEntry(
    entry: DeletionMediaLedgerEntry,
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
        if (cleanup) throw new Error("DELETION_MEDIA_CLEANUP_DUPLICATE");
        cleanup = released.cleanupIntent;
      }
    }
    const current =
      entry.namespace === "asset"
        ? this.options.assets.get(entry.mediaId)
        : this.options.originals.get(entry.mediaId);
    if (entry.expectedRemainingRefs === 0) {
      if (current || !cleanup)
        throw new Error("DELETION_MEDIA_RELEASE_MISMATCH");
    } else if (
      !current ||
      current.sha256 !== entry.checksum ||
      current.refCount !== entry.expectedRemainingRefs ||
      cleanup
    ) {
      throw new Error("DELETION_MEDIA_RELEASE_MISMATCH");
    }
    return cleanup;
  }

  private deleteParticipantGraph(
    operationId: string,
    fresh: DeletionInventorySnapshot,
    currentJobs: ReadonlyMap<string, JobRecord>,
  ): void {
    for (const item of fresh.deleteOrder) {
      const document =
        item.collection === "jobs"
          ? (currentJobs.get(item.id) ?? item.document)
          : item.document;
      this.deletionStorage.deleteInTransaction({
        operationId,
        collection: item.collection,
        id: item.id,
        document,
      });
    }
  }

  private async advanceCleanup(
    operationId: string,
  ): Promise<DeletionOperation> {
    let operation = this.requireOperation(operationId);
    if (operation.state === "verified") return operation;
    assertDeletionLedgerRoot(
      this.ledgers,
      operation.id,
      "deletion_unlinks",
      operation.unlinkLedgerRoot,
    );
    const latest = latestManagedUnlinks(this.ledgers, operation.id);
    const retryable = latest.filter(
      (entry) => entry.state === "pending" || entry.state === "blocked",
    );
    if (retryable.some((entry) => entry.attempts >= maximumCleanupAttempts))
      throw new Error("DELETION_CLEANUP_RETRY_LIMIT");
    const outcomes = await this.options.cleanup.execute(retryable);
    this.options.hooks?.afterFilesystemBatch?.();
    operation = this.recordCleanupOutcomes(operation, outcomes);
    if (operation.state === "cleanup_required") return operation;
    return this.verifyAndFinalize(operation);
  }

  private recordCleanupOutcomes(
    current: DeletionOperation,
    outcomes: readonly ManagedUnlinkLedgerEntry[],
  ): DeletionOperation {
    return this.options.store.transactionImmediate(() => {
      const persisted = this.requireOperation(current.id);
      const root = this.appendLedger(
        persisted.id,
        "deletion_unlinks",
        outcomes,
        this.nowIso(),
      );
      const blocked = outcomes.filter((entry) => entry.state === "blocked");
      const next = deletionOperationSchema.parse({
        ...persisted,
        revision: persisted.revision + 1,
        updatedAt: this.nowIso(),
        state: blocked.length > 0 ? "cleanup_required" : "verifying",
        unlinkLedgerRoot: root.rootHash,
        counts: { ...persisted.counts, failedChecks: blocked.length },
        failureCode: blocked[0]?.failureCode ?? null,
      });
      return this.operations.updateInTransaction(persisted, next);
    });
  }

  private async verifyAndFinalize(
    current: DeletionOperation,
  ): Promise<DeletionOperation> {
    const inventoryEntries = this.inventoryEntries(current);
    const unlinks = latestManagedUnlinks(this.ledgers, current.id);
    const checks = await verifyDeletion({
      store: this.options.store,
      registry: this.options.registry,
      assets: this.options.assets,
      originals: this.options.originals,
      cleanup: this.options.cleanup,
      operation: current,
      inventoryEntries,
      unlinks,
    });
    return this.options.store.transactionImmediate(() => {
      const persisted = this.requireOperation(current.id);
      const root = this.appendLedger(
        persisted.id,
        "deletion_verification",
        checks,
        this.nowIso(),
      );
      const failures = checks.filter((entry) => !entry.passed);
      if (failures.length > 0) {
        return this.operations.updateInTransaction(
          persisted,
          deletionOperationSchema.parse({
            ...persisted,
            revision: persisted.revision + 1,
            updatedAt: this.nowIso(),
            state: "cleanup_required",
            verificationLedgerRoot: root.rootHash,
            counts: { ...persisted.counts, failedChecks: failures.length },
            failureCode: "DELETION_VERIFICATION_FAILED",
          }),
        );
      }
      return this.finalizeVerified(persisted, root.rootHash);
    });
  }

  private finalizeVerified(
    operation: DeletionOperation,
    verificationRoot: string,
  ): DeletionOperation {
    const verifiedAt = this.nowIso();
    const releasing = this.locks.transitionInTransaction(
      operation.lockId,
      operation.id,
      operation.lockRevision,
      "releasing",
    );
    const report = createVerifiedDeletionReport(
      operation,
      verificationRoot,
      verifiedAt,
    );
    this.reports.insertInTransaction(report);
    const verified = this.operations.updateInTransaction(
      operation,
      deletionOperationSchema.parse({
        ...operation,
        revision: operation.revision + 1,
        updatedAt: verifiedAt,
        state: "verified",
        lockRevision: releasing.revision,
        counts: { ...operation.counts, failedChecks: 0 },
        verificationLedgerRoot: verificationRoot,
        reportId: report.id,
        failureCode: null,
        verifiedAt,
      }),
    );
    this.locks.releaseInTransaction(
      releasing.id,
      operation.id,
      releasing.revision,
    );
    return verified;
  }

  private inventoryEntries(
    operation: DeletionOperation,
  ): PortabilityLedgerEntry[] {
    assertDeletionLedgerRoot(
      this.ledgers,
      operation.inventoryId,
      "deletion_inventory",
      operation.inventoryLedgerRoot,
    );
    return this.ledgers
      .pages(operation.inventoryId, "deletion_inventory")
      .flatMap((page) => page.entries);
  }

  private appendLedger(
    operationId: string,
    ledgerKind:
      | "deletion_unlinks"
      | "shared_preservation"
      | "deletion_verification"
      | "report_detail",
    entries: readonly PortabilityLedgerEntry[],
    nowIso: string,
  ) {
    return appendDeletionLedgerPages({
      store: this.options.store,
      repository: this.ledgers,
      operationId,
      ledgerKind,
      entries,
      nowIso,
      idFactory: this.idFactory,
    });
  }

  private requireInventory(id: string): DeletionInventory {
    const inventory = this.inventories.get(id);
    if (!inventory) throw new Error("DELETION_INVENTORY_NOT_FOUND");
    return inventory;
  }

  private requireOperation(id: string): DeletionOperation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error("DELETION_OPERATION_NOT_FOUND");
    return operation;
  }
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

function compareUnlinks(
  left: ManagedUnlinkLedgerEntry,
  right: ManagedUnlinkLedgerEntry,
): number {
  return (
    left.namespace.localeCompare(right.namespace) ||
    left.mediaId.localeCompare(right.mediaId)
  );
}
