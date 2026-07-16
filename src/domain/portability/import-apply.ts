import { ulid } from "ulid";

import { canonicalJson } from "../../contracts/canonical-json.js";
import { preflightImportDisk } from "../../portability/disk-preflight.js";
import {
  loadValidatedImportSource,
  type LoadedValidatedImportSource,
} from "../../portability/import-staging-reader.js";
import {
  importCommitRequestSchema,
  importCommitResultSchema,
  type ImportCommitRequest,
  type ImportCommitResult,
} from "./import-apply-model.js";
import {
  ImportApplyMediaCoordinator,
  type ImportApplyMediaInput,
} from "./import-apply-media.js";
import { ParticipantImportStorage } from "./import-apply-storage.js";
import {
  applyMediaInput,
  assertCommitActionMatches,
  assertCommittedGraph,
  assertMatchingProgress,
  assertPlanSource,
  assertPreparing,
  assertProofPinned,
  assertWriteTargets,
  boundedFailureCode,
  commitActionResult,
  commitBoundaryInput,
  commitLock,
  currentTargetSnapshotHash,
  importScope,
  requestFromProgress,
  requiredCommit,
  requiredHash,
  requiredId,
  targetRootIds,
  type RecompiledImportPlan,
} from "./import-apply-support.js";
import type {
  ImportApplyMediaPort,
  ImportApplyRecoveryResult,
  ImportApplyResult,
  ImportApplyServiceOptions,
  ImportApplySourceLoader,
} from "./import-apply-types.js";
export type {
  ImportApplyHooks,
  ImportApplyRecoveryResult,
  ImportApplyResult,
  ImportApplyServiceOptions,
} from "./import-apply-types.js";
import {
  appendImportCleanupPages,
  latestImportCleanupEntries,
} from "./import-cleanup-ledger.js";
import type { ImportOperation } from "./import-model.js";
import { assertImportPlanConfirmation } from "./import-plan.js";
import type { ImportPlan } from "./import-plan-model.js";
import { recompileStoredImportPlan } from "./import-plan-replay.js";
import { ImportPlanRepository } from "./import-plan-storage.js";
import {
  DocumentStoreImportPlanTargetReader,
  type ImportPlanTargetReader,
} from "./import-plan-target.js";
import {
  ImportReplaceBoundary,
  type FinalizedReplaceBoundary,
} from "./import-replace.js";
import { ImportOperationRepository } from "./import-storage.js";
import {
  PortabilityActionBoundary,
  type PortabilityActionBoundaryInput,
} from "./operation-ledgers.js";
import {
  PortabilityActionRepository,
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
  PortabilityStorageError,
} from "./repositories.js";
import { ScopeAdmissionService } from "./scope-locks.js";
import type {
  PortabilityAction,
  PortabilityScopeLock,
} from "./schemas.js";

type Replay = RecompiledImportPlan;

/**
 * Applies one immutable import plan. Product rows, media references, replace
 * cancellation/deletion, cleanup intent, operation result, and action record
 * share one SQLite transaction.
 */
export class ImportApplyService {
  private readonly operations: ImportOperationRepository;
  private readonly plans: ImportPlanRepository;
  private readonly actions: PortabilityActionRepository;
  private readonly ledgers: PortabilityLedgerRepository;
  private readonly lockRepository: PortabilityScopeLockRepository;
  private readonly locks: ScopeAdmissionService;
  private readonly target: ImportPlanTargetReader;
  private readonly boundary: PortabilityActionBoundary;
  private readonly storage: ParticipantImportStorage;
  private readonly media: ImportApplyMediaPort;
  private readonly replaceBoundary: ImportReplaceBoundary;
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;
  private readonly diskPreflight: NonNullable<
    ImportApplyServiceOptions["diskPreflight"]
  >;
  private readonly sourceLoader: ImportApplySourceLoader;
  private readonly inFlight = new Map<string, Promise<ImportApplyResult>>();

  constructor(private readonly options: ImportApplyServiceOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.operations = new ImportOperationRepository(options.store);
    this.plans = new ImportPlanRepository(options.store);
    this.actions = new PortabilityActionRepository(options.store);
    this.ledgers = new PortabilityLedgerRepository(options.store);
    this.lockRepository = new PortabilityScopeLockRepository(options.store);
    this.locks = new ScopeAdmissionService(
      options.store,
      this.lockRepository,
      this.ledgers,
      { nowIso: this.nowIso, idFactory: this.idFactory },
    );
    this.target =
      options.target ?? new DocumentStoreImportPlanTargetReader(options.store);
    this.boundary = new PortabilityActionBoundary(
      options.store,
      this.actions,
      { nowIso: this.nowIso, idFactory: this.idFactory },
    );
    this.storage = new ParticipantImportStorage(options.store, options.registry);
    this.media =
      options.media ??
      new ImportApplyMediaCoordinator(
        options.store,
        options.assets,
        options.originals,
        { nowIso: this.nowIso, idFactory: this.idFactory },
      );
    this.replaceBoundary =
      options.replaceBoundary ??
      new ImportReplaceBoundary({
        store: options.store,
        registry: options.registry,
        assets: options.assets,
        originals: options.originals,
        nowIso: this.nowIso,
        idFactory: this.idFactory,
      });
    this.diskPreflight = options.diskPreflight ?? preflightImportDisk;
    this.sourceLoader = options.sourceLoader ?? loadValidatedImportSource;
  }

  commit(operationId: string, value: unknown): Promise<ImportApplyResult> {
    const request = importCommitRequestSchema.parse(value);
    const key = `${operationId}\0${request.idempotencyKey}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const started = this.commitOnce(operationId, request).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, started);
    return started;
  }

  async recover(): Promise<ImportApplyRecoveryResult> {
    const resumed: string[] = [];
    const cleanupCompleted: string[] = [];
    const rollbackCompleted: string[] = [];
    const failed: Array<{ operationId: string; failureCode: string }> = [];
    for (const operation of this.operations.list()) {
      if (!operation.commit) continue;
      try {
        if (
          operation.state === "committing" &&
          operation.commit.phase === "preparing"
        ) {
          await this.commit(operation.id, requestFromProgress(operation));
          resumed.push(operation.id);
        } else if (
          (operation.state === "imported" ||
            operation.state === "cleanup_required") &&
          operation.commit.result !== null
        ) {
          await this.finishCommitted(operation.id);
          cleanupCompleted.push(operation.id);
        } else if (
          operation.state === "cleanup_required" &&
          operation.commit.result === null
        ) {
          await this.finishRollback(operation.id);
          rollbackCompleted.push(operation.id);
        } else if (
          operation.state === "committing" &&
          operation.commit.phase === "rolling_back"
        ) {
          await this.markRollbackRequired(
            operation.id,
            operation.commit.failureCode ?? "IMPORT_COMMIT_FAILED",
          );
          await this.finishRollback(operation.id);
          rollbackCompleted.push(operation.id);
        }
      } catch (error) {
        failed.push({
          operationId: operation.id,
          failureCode: boundedFailureCode(error),
        });
      }
    }
    return {
      resumed: Object.freeze(resumed),
      cleanupCompleted: Object.freeze(cleanupCompleted),
      rollbackCompleted: Object.freeze(rollbackCompleted),
      failed: Object.freeze(failed),
    };
  }

  private async commitOnce(
    operationId: string,
    request: ImportCommitRequest,
  ): Promise<ImportApplyResult> {
    const initial = this.requireOperation(operationId);
    const plan = this.requirePlan(request.planId, operationId);
    assertImportPlanConfirmation(plan, request.confirmationHash);
    const boundaryInput = commitBoundaryInput(initial, plan, request);
    const replay = this.precheckAction(boundaryInput);
    if (replay) {
      await this.finishCommittedIfNeeded(operationId);
      return this.resultFromAction(replay, true);
    }
    let operation = this.beginOrResume(initial, plan, request, boundaryInput);
    await this.options.hooks?.afterLockAcquired?.(operation);
    let mediaInput: ImportApplyMediaInput | null = null;
    try {
      const prepared = await this.loadReplay(operation, plan);
      mediaInput = applyMediaInput(operation.id, plan.id, prepared);
      operation = this.pinPreparation(operation.id, plan, prepared, mediaInput);
      await this.options.hooks?.afterSourceSnapshot?.(operation);
      await this.media.prepare(mediaInput);
      const final = await this.loadReplay(this.requireOperation(operation.id), plan);
      assertProofPinned(operation.id, final.loaded.sourceProofHash, this.operations);
      await this.repeatDiskPreflight(this.requireOperation(operation.id));
      const finalMediaInput = applyMediaInput(operation.id, plan.id, final);
      const committed = this.commitGraph(
        operation.id,
        plan,
        boundaryInput,
        final,
        finalMediaInput,
      );
      await this.options.hooks?.afterDbCommit?.();
      await this.finishCommitted(operation.id);
      return this.resultFromAction(committed.action, committed.replayed);
    } catch (error) {
      const current = this.requireOperation(operation.id);
      if (current.commit?.result) {
        await this.markCommittedCleanupRequired(
          operation.id,
          boundedFailureCode(error),
        );
      } else {
        await this.markRollbackRequired(
          operation.id,
          boundedFailureCode(error),
        );
        try {
          await this.finishRollback(operation.id, mediaInput ?? undefined);
        } catch {
          // The durable cleanup_required branch retains its scope lock.
        }
      }
      throw error;
    }
  }

  private beginOrResume(
    initial: ImportOperation,
    plan: ImportPlan,
    request: ImportCommitRequest,
    boundaryInput: PortabilityActionBoundaryInput,
  ): ImportOperation {
    if (initial.commit) {
      assertMatchingProgress(initial, plan, request, boundaryInput.requestHash);
      if (
        initial.state !== "committing" ||
        initial.commit.phase !== "preparing"
      )
        throw new Error("IMPORT_COMMIT_STATE_INVALID");
      this.requireOperationLock(initial);
      return initial;
    }
    return this.options.store.transactionImmediate(() => {
      const current = this.requireOperation(initial.id);
      if (
        current.state !== "plan_ready" ||
        current.revision !== request.expectedOperationRevision ||
        current.planId !== plan.id ||
        current.mode !== plan.mode
      )
        throw new Error("IMPORT_OPERATION_REVISION_CONFLICT");
      const prepared = this.prepareLockInTransaction(current.id, plan);
      const action = plan.mode === "replace_existing" ? "replace_commit" : "import_commit";
      return this.operations.replaceInTransaction(
        {
          ...current,
          revision: current.revision + 1,
          updatedAt: this.nowIso(),
          state: "committing",
          cleanupState: "pending",
          commit: {
            action,
            idempotencyKey: request.idempotencyKey,
            requestHash: boundaryInput.requestHash,
            expectedOperationRevision: request.expectedOperationRevision,
            planConfirmationHash: plan.confirmationHash,
            phase: "preparing",
            lock: commitLock(prepared.lock),
            sourceProofHash: null,
            targetSnapshotHash: prepared.targetSnapshotHash,
            preparedCount: plan.counts.preparedMedia,
            result: null,
            failureCode: null,
          },
        },
        current.revision,
      );
    });
  }

  private prepareLockInTransaction(
    operationId: string,
    plan: ImportPlan,
  ): { lock: PortabilityScopeLock; targetSnapshotHash: string | null } {
    if (plan.mode === "replace_existing")
      return this.replaceBoundary.prepareLockInTransaction({ operationId, plan });
    const root = this.ledgers.root(operationId, "captured_attempts");
    if (root.entryCount !== 0)
      throw new Error("IMPORT_COMMIT_CAPTURE_LEDGER_INVALID");
    const lock = this.locks.acquireManyInTransaction([
      {
        operationId,
        scope: importScope(plan),
        mode: "import_commit",
        phase: "exclusive",
        capturedAttemptLedgerRoot: root.rootHash,
        capturedAttemptCount: 0,
      },
    ])[0];
    return { lock, targetSnapshotHash: null };
  }

  private async loadReplay(
    operation: ImportOperation,
    plan: ImportPlan,
  ): Promise<{ loaded: LoadedValidatedImportSource; replay: Replay }> {
    if (!operation.reservationKey || !operation.stagingKey)
      throw new Error("IMPORT_COMMIT_SOURCE_MISSING");
    await this.options.managedImports.verifyReservation(
      operation.reservationKey,
      {
        bytes: operation.sourceArchiveBytes,
        sha256: operation.sourceArchiveHash,
      },
    );
    const loaded = await this.sourceLoader({
      directory: this.options.managedImports.stagingPath(operation.stagingKey),
      operation,
      registry: this.options.registry,
    });
    assertPlanSource(operation, plan, loaded, this.options.registry.hash);
    const replay = recompileStoredImportPlan({
      plan,
      source: loaded.source,
      ledgers: this.ledgers,
      registry: this.options.registry,
      target: this.target,
    });
    assertWriteTargets(plan, replay, this.target);
    return { loaded, replay };
  }

  private pinPreparation(
    operationId: string,
    plan: ImportPlan,
    prepared: { loaded: LoadedValidatedImportSource; replay: Replay },
    mediaInput: ImportApplyMediaInput,
  ): ImportOperation {
    return this.options.store.transactionImmediate(() => {
      const current = this.requireOperation(operationId);
      assertPreparing(current, plan);
      const targetSnapshotHash =
        plan.mode === "replace_existing"
          ? requiredHash(current.commit?.targetSnapshotHash)
          : currentTargetSnapshotHash(plan, prepared.replay, this.target);
      if (
        current.commit?.sourceProofHash !== null &&
        current.commit?.sourceProofHash !== prepared.loaded.sourceProofHash
      )
        throw new Error("IMPORT_COMMIT_SOURCE_PROOF_MISMATCH");
      if (
        current.commit?.targetSnapshotHash !== null &&
        current.commit?.targetSnapshotHash !== targetSnapshotHash
      )
        throw new Error("IMPORT_COMMIT_TARGET_SNAPSHOT_MISMATCH");
      this.media.reserveInTransaction(mediaInput);
      if (
        current.commit?.sourceProofHash === prepared.loaded.sourceProofHash &&
        current.commit.targetSnapshotHash === targetSnapshotHash
      )
        return current;
      return this.operations.replaceInTransaction(
        {
          ...current,
          revision: current.revision + 1,
          updatedAt: this.nowIso(),
          commit: {
            ...requiredCommit(current),
            sourceProofHash: prepared.loaded.sourceProofHash,
            targetSnapshotHash,
          },
        },
        current.revision,
      );
    });
  }

  private commitGraph(
    operationId: string,
    plan: ImportPlan,
    boundaryInput: PortabilityActionBoundaryInput,
    final: { loaded: LoadedValidatedImportSource; replay: Replay },
    mediaInput: ImportApplyMediaInput,
  ) {
    let committedResult: ImportCommitResult | null = null;
    const boundary = this.options.store.transactionImmediate(() => {
      const result = this.boundary.runInTransaction(boundaryInput, (identity) => {
        const current = this.requireOperation(operationId);
        assertPreparing(current, plan);
        const lock = this.requireOperationLock(current);
        if (current.commit?.sourceProofHash !== final.loaded.sourceProofHash)
          throw new Error("IMPORT_COMMIT_SOURCE_PROOF_MISMATCH");
        const replay = recompileStoredImportPlan({
          plan,
          source: final.loaded.source,
          ledgers: this.ledgers,
          registry: this.options.registry,
          target: this.target,
        });
        assertWriteTargets(plan, replay, this.target);
        let finalLock = lock;
        let replace: FinalizedReplaceBoundary | null = null;
        if (plan.mode === "replace_existing") {
          replace = this.replaceBoundary.finalizeInTransaction({
            operationId,
            plan,
            lock,
            targetSnapshotHash: requiredHash(current.commit?.targetSnapshotHash),
            storage: this.storage,
            retainedMediaDeltas: replay.compiled.releases,
            commitImportedMediaInTransaction: () =>
              this.media.commitInTransaction(mediaInput),
          });
          finalLock = replace.lockExclusive;
        } else {
          const expected = currentTargetSnapshotHash(plan, replay, this.target);
          if (current.commit?.targetSnapshotHash !== expected)
            throw new Error("IMPORT_COMMIT_TARGET_SNAPSHOT_MISMATCH");
          this.media.commitInTransaction(mediaInput);
        }
        this.insertCompiledDocuments(operationId, plan, replay);
        assertCommittedGraph(replay, this.target);
        const cleanupRoot = appendImportCleanupPages({
          store: this.options.store,
          repository: this.ledgers,
          operationId,
          entries: replace?.unlinks ?? [],
          nowIso: identity.recordedAt,
          idFactory: this.idFactory,
        });
        committedResult = importCommitResultSchema.parse({
          graphHash: replay.graphHash,
          targetRootIds: targetRootIds(plan),
          documentCount: replay.compiled.documents.length,
          preparedMediaCount: replay.compiled.preparedMedia.length,
          canceledJobCount: replace?.canceledJobIds.length ?? 0,
          cleanupLedgerRoot: cleanupRoot.rootHash,
          committedAt: identity.recordedAt,
        });
        this.operations.replaceInTransaction(
          {
            ...current,
            revision: current.revision + 1,
            updatedAt: identity.recordedAt,
            state: "imported",
            actionRefs: { ...current.actionRefs, commitActionId: identity.id },
            commit: {
              ...requiredCommit(current),
              phase: "graph_committed",
              lock: commitLock(finalLock),
              result: committedResult,
              failureCode: null,
            },
            failureCode: null,
            cleanupState: "pending",
          },
          current.revision,
        );
        return commitActionResult(plan, committedResult);
      });
      this.options.hooks?.beforeDbCommit?.();
      return result;
    });
    if (!committedResult && !boundary.replayed)
      throw new Error("IMPORT_COMMIT_RESULT_MISSING");
    return boundary;
  }

  private insertCompiledDocuments(
    operationId: string,
    plan: ImportPlan,
    replay: Replay,
  ): void {
    const purpose =
      plan.mode === "replace_existing" ? "replace_commit" : "import_commit";
    for (const item of replay.compiled.documents) {
      if (item.collection === "assets" || item.collection === "original_assets")
        continue;
      if (plan.mode !== "replace_existing" && item.disposition !== "create")
        throw new Error("IMPORT_COMMIT_WRITE_DISPOSITION_INVALID");
      this.storage.insertInTransaction({
        operationId,
        purpose,
        collection: item.collection,
        document: item.document,
      });
    }
  }

  private async repeatDiskPreflight(operation: ImportOperation): Promise<void> {
    const facts = operation.diskFacts;
    if (!facts) throw new Error("IMPORT_COMMIT_DISK_FACTS_MISSING");
    await this.diskPreflight({
      root: this.options.managedImports.root,
      reserveBytes: this.options.reserveBytes ?? facts.reserveBytes,
      declaredUncompressedBytes: facts.declaredUncompressedBytes,
      newContentBytes: facts.newContentBytes,
      canonicalDocumentBytes: facts.canonicalDocumentBytes,
    });
  }

  private async finishCommittedIfNeeded(operationId: string): Promise<void> {
    const operation = this.requireOperation(operationId);
    if (
      operation.commit?.result &&
      (operation.state === "cleanup_required" ||
        operation.commit.phase === "graph_committed")
    )
      await this.finishCommitted(operationId);
  }

  private async finishCommitted(operationId: string): Promise<ImportOperation> {
    let current = this.requireOperation(operationId);
    if (!current.commit?.result)
      throw new Error("IMPORT_COMMIT_RESULT_MISSING");
    if (current.state === "imported" && current.commit.phase === "complete")
      return current;
    const entries = latestImportCleanupEntries(this.ledgers, operationId);
    const outcomes = await this.options.cleanup.execute(entries);
    if (canonicalJson(entries) !== canonicalJson(outcomes))
      this.options.store.transactionImmediate(() =>
        appendImportCleanupPages({
          store: this.options.store,
          repository: this.ledgers,
          operationId,
          entries: outcomes,
          nowIso: this.nowIso(),
          idFactory: this.idFactory,
        }),
      );
    await this.options.hooks?.beforeCleanupVerification?.();
    for (const entry of outcomes) {
      const verification = await this.options.cleanup.verify(entry);
      if (!verification.passed)
        throw new Error(verification.failureCode ?? "IMPORT_CLEANUP_FAILED");
    }
    if (current.stagingKey)
      await this.options.managedImports.removeStaging(current.stagingKey);
    if (current.reservationKey)
      await this.options.managedImports.removeReservation(current.reservationKey);
    current = this.options.store.transactionImmediate(() => {
      const operation = this.requireOperation(operationId);
      const lock = this.requireOperationLock(operation);
      const releasing = this.locks.transitionInTransaction(
        lock.id,
        operationId,
        lock.revision,
        "releasing",
      );
      this.locks.releaseInTransaction(
        releasing.id,
        operationId,
        releasing.revision,
      );
      return this.operations.replaceInTransaction(
        {
          ...operation,
          revision: operation.revision + 1,
          updatedAt: this.nowIso(),
          state: "imported",
          reservationKey: null,
          stagingKey: null,
          commit: {
            ...requiredCommit(operation),
            phase: "complete",
            lock: commitLock(releasing),
            failureCode: null,
          },
          failureCode: null,
          cleanupState: "complete",
        },
        operation.revision,
      );
    });
    return current;
  }

  private async markCommittedCleanupRequired(
    operationId: string,
    failureCode: string,
  ): Promise<void> {
    this.options.store.transactionImmediate(() => {
      const current = this.requireOperation(operationId);
      if (!current.commit?.result) return;
      if (
        current.state === "cleanup_required" &&
        current.failureCode === failureCode
      )
        return;
      this.operations.replaceInTransaction(
        {
          ...current,
          revision: current.revision + 1,
          updatedAt: this.nowIso(),
          state: "cleanup_required",
          commit: {
            ...current.commit,
            phase: "cleanup_required",
            failureCode,
          },
          failureCode,
          cleanupState: "failed",
        },
        current.revision,
      );
    });
  }

  private async markRollbackRequired(
    operationId: string,
    failureCode: string,
  ): Promise<void> {
    this.options.store.transactionImmediate(() => {
      const current = this.requireOperation(operationId);
      if (!current.commit || current.commit.result) return;
      if (current.state === "cleanup_required") return;
      this.operations.replaceInTransaction(
        {
          ...current,
          revision: current.revision + 1,
          updatedAt: this.nowIso(),
          state: "cleanup_required",
          commit: {
            ...current.commit,
            phase: "cleanup_required",
            failureCode,
          },
          failureCode,
          cleanupState: "failed",
        },
        current.revision,
      );
    });
  }

  private async finishRollback(
    operationId: string,
    knownMedia?: ImportApplyMediaInput,
  ): Promise<ImportOperation> {
    let current = this.requireOperation(operationId);
    if (current.commit?.result)
      throw new Error("IMPORT_COMMIT_ROLLBACK_AFTER_COMMIT_FORBIDDEN");
    const preparedRows = this.media.repository.list(operationId);
    if (preparedRows.length > 0) {
      const mediaInput = knownMedia ?? (await this.rollbackMediaInput(current));
      await this.media.discard(mediaInput);
    }
    if (current.stagingKey)
      await this.options.managedImports.removeStaging(current.stagingKey);
    if (current.reservationKey)
      await this.options.managedImports.removeReservation(current.reservationKey);
    current = this.options.store.transactionImmediate(() => {
      const operation = this.requireOperation(operationId);
      const lock = this.requireOperationLock(operation);
      const releasing = this.locks.transitionInTransaction(
        lock.id,
        operationId,
        lock.revision,
        "releasing",
      );
      this.locks.releaseInTransaction(
        releasing.id,
        operationId,
        releasing.revision,
      );
      return this.operations.replaceInTransaction(
        {
          ...operation,
          revision: operation.revision + 1,
          updatedAt: this.nowIso(),
          state: "rolled_back",
          reservationKey: null,
          stagingKey: null,
          commit: {
            ...requiredCommit(operation),
            phase: "rolled_back",
            lock: commitLock(releasing),
          },
          cleanupState: "complete",
        },
        operation.revision,
      );
    });
    return current;
  }

  private async rollbackMediaInput(
    operation: ImportOperation,
  ): Promise<ImportApplyMediaInput> {
    const plan = this.requirePlan(requiredId(operation.planId), operation.id);
    const prepared = await this.loadReplay(operation, plan);
    return applyMediaInput(operation.id, plan.id, prepared);
  }

  private requireOperationLock(operation: ImportOperation): PortabilityScopeLock {
    const expected = requiredCommit(operation).lock;
    const current = this.lockRepository.get(expected.id);
    if (
      !current ||
      current.operationId !== operation.id ||
      current.mode !== expected.mode ||
      current.phase !== expected.phase ||
      current.revision !== expected.revision ||
      canonicalJson(current.scope) !== canonicalJson(expected.scope)
    )
      throw new Error("IMPORT_COMMIT_LOCK_STALE");
    return current;
  }

  private precheckAction(
    input: PortabilityActionBoundaryInput,
  ): PortabilityAction | null {
    const existing = this.actions.find(
      input.operationScope,
      input.action,
      input.idempotencyKey,
    );
    if (!existing) return null;
    if (existing.requestHash !== input.requestHash)
      throw new PortabilityStorageError(
        "PORTABILITY_ACTION_IDEMPOTENCY_COLLISION",
      );
    return existing;
  }

  private resultFromAction(
    action: PortabilityAction,
    replayed: boolean,
  ): ImportApplyResult {
    const current = this.requireOperation(action.operationScope.id);
    const result = current.commit?.result;
    if (
      action.operationScope.kind !== "import_operation" ||
      !result ||
      action.id !== current.actionRefs.commitActionId
    )
      throw new Error("IMPORT_COMMIT_ACTION_RESULT_INVALID");
    assertCommitActionMatches(action, result);
    return { action, current, result, replayed };
  }

  private requireOperation(id: string): ImportOperation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error("IMPORT_OPERATION_NOT_FOUND");
    return operation;
  }

  private requirePlan(id: string, operationId: string): ImportPlan {
    const plan = this.plans.get(id);
    if (!plan || plan.operationId !== operationId)
      throw new Error("IMPORT_PLAN_NOT_FOUND");
    return plan;
  }
}
