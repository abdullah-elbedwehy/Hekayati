import { createHash } from "node:crypto";

import { ulid } from "ulid";

import type { AssetStore } from "../../assets/asset-store.js";
import type { OriginalAssetStore } from "../../assets/original-asset-store.js";
import { writeDeterministicArchive } from "../../portability/export.js";
import {
  ManagedExportReleaseError,
  type ManagedExportStore,
} from "../../portability/managed-export-store.js";
import type { ManifestV2 } from "../../portability/manifest.js";
import {
  scanStagedArchive,
  verifyFinalizedArchive,
} from "../../portability/release-gate.js";
import { SecretReleaseGate } from "../../portability/secret-scan.js";
import { snapshotArchiveSources } from "../../portability/snapshot-sources.js";
import type { SnapshotStagingStore } from "../../portability/staging-store.js";
import type { JobScheduler } from "../../jobs/scheduler.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { Project } from "../authoring/schemas.js";
import type { DocumentStore } from "../repository/document-store.js";
import type {
  ExportOperation,
  ManagedExport,
  PortabilityMediaHold,
  PortabilitySnapshot,
  PortabilitySnapshotEntry,
} from "./export-model.js";
import {
  assertExecutableState,
  assertPauseAcknowledgements,
  capturedProjectAttempts,
  executionFailureCode,
  initialOperation,
  inlineEntityId,
  managedExportRecord,
  manifestForOperation,
  requiredHash,
} from "./export-service-support.js";
import {
  ExportOperationRepository,
  ManagedExportRepository,
  PortabilitySnapshotRepository,
} from "./export-storage.js";
import {
  CapturedAttemptLedger,
  PortabilityActionBoundary,
  portabilityActionRequestHash,
} from "./operation-ledgers.js";
import type { PortabilityRegistry } from "./participants.js";
import { ProjectSnapshotFreezer } from "./snapshot-entries.js";
import {
  PortabilityActionRepository,
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
} from "./repositories.js";
import { ScopeAdmissionService } from "./scope-locks.js";
import type {
  PortabilityAction,
  PortabilityActionResult,
  PortabilityScopeLock,
} from "./schemas.js";

export interface ProjectExportServiceOptions {
  store: DocumentStore;
  registry: PortabilityRegistry;
  assets: AssetStore;
  originals: OriginalAssetStore;
  scheduler: Pick<JobScheduler, "list" | "pauseProject">;
  stagingStore: SnapshotStagingStore;
  managedStore: ManagedExportStore;
  appVersion: string;
  nowIso?: () => string;
  idFactory?: () => string;
}

export interface PauseProjectExportInput {
  projectId: string;
  expectedProjectRevision: number;
  idempotencyKey: string;
  requestHash: string;
  acknowledgedChildPhotos: boolean;
  acknowledgedNoAutomaticBackup: boolean;
}

export interface PauseProjectExportResult {
  result: PortabilityActionResult;
  action: PortabilityAction;
  current: {
    operation: ExportOperation;
    lock: PortabilityScopeLock | null;
  };
  replayed: boolean;
}

export interface StartProjectExportInput {
  projectId: string;
  operationId: string;
  expectedProjectRevision: number;
  expectedOperationRevision: number;
  idempotencyKey: string;
  requestHash: string;
}

export interface StartProjectExportResult {
  result: PortabilityActionResult;
  action: PortabilityAction;
  current: {
    operation: ExportOperation;
    snapshot: PortabilitySnapshot;
  };
  replayed: boolean;
}

export interface ReadyProjectExportResult {
  operation: ExportOperation;
  managedExport: ManagedExport;
  manifest: ManifestV2;
  stagingCleanup: "complete" | "pending";
}

export interface OpenProjectExportDownloadInput {
  exportId: string;
  projectId: string;
  customerId: string;
  familyId: string;
}

export class ProjectExportService {
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;
  private readonly projects: AuthoringRepositories["projects"];
  private readonly operations: ExportOperationRepository;
  private readonly snapshots: PortabilitySnapshotRepository;
  private readonly managedExports: ManagedExportRepository;
  private readonly freezer: ProjectSnapshotFreezer;
  private readonly actionBoundary: PortabilityActionBoundary;
  private readonly capturedAttempts: CapturedAttemptLedger;
  private readonly locks: PortabilityScopeLockRepository;
  private readonly admission: ScopeAdmissionService;

  constructor(private readonly options: ProjectExportServiceOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.projects = new AuthoringRepositories(options.store).projects;
    this.operations = new ExportOperationRepository(options.store);
    this.snapshots = new PortabilitySnapshotRepository(
      options.store,
      options.registry,
      this.clockOptions(),
    );
    this.managedExports = new ManagedExportRepository(options.store);
    this.freezer = new ProjectSnapshotFreezer({
      store: options.store,
      registry: options.registry,
      assets: options.assets,
      originals: options.originals,
      ...this.clockOptions(),
    });
    const actions = new PortabilityActionRepository(options.store);
    const ledgers = new PortabilityLedgerRepository(options.store);
    this.locks = new PortabilityScopeLockRepository(options.store);
    this.actionBoundary = new PortabilityActionBoundary(
      options.store,
      actions,
      this.clockOptions(),
    );
    this.capturedAttempts = new CapturedAttemptLedger(
      options.store,
      ledgers,
      this.clockOptions(),
    );
    this.admission = new ScopeAdmissionService(
      options.store,
      this.locks,
      ledgers,
      this.clockOptions(),
    );
  }

  pause(input: PauseProjectExportInput): PauseProjectExportResult {
    assertPauseAcknowledgements(input);
    const request = pauseActionRequest(input);
    const boundary = this.actionBoundary.run(
      {
        ...request,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      },
      () => this.pauseInTransaction(input),
    );
    const operationId = inlineEntityId(boundary.action, 0);
    return {
      result: boundary.action.result,
      action: boundary.action,
      current: {
        operation: this.requireOperation(operationId),
        lock: this.findOperationLock(operationId),
      },
      replayed: boundary.replayed,
    };
  }

  start(input: StartProjectExportInput): StartProjectExportResult {
    const request = startActionRequest(input);
    const boundary = this.actionBoundary.run(
      {
        ...request,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      },
      () => this.startInTransaction(input),
    );
    const operation = this.requireOperation(inlineEntityId(boundary.action, 0));
    return {
      result: boundary.action.result,
      action: boundary.action,
      current: {
        operation,
        snapshot: this.requireSnapshot(operation),
      },
      replayed: boundary.replayed,
    };
  }

  async execute(operationId: string): Promise<ReadyProjectExportResult> {
    let operation = this.requireOperation(operationId);
    if (operation.state === "ready") {
      const snapshotId = this.requireSnapshot(operation).id;
      const ready = this.readyResult(operation);
      return {
        ...ready,
        stagingCleanup: await this.cleanupStaging(snapshotId),
      };
    }
    assertExecutableState(operation);
    const snapshot = this.requireSnapshot(operation);
    const entries = this.snapshots.entries(snapshot.id);
    const manifest = manifestForOperation(
      operation,
      snapshot,
      entries,
      this.options.appVersion,
    );
    let published: Awaited<ReturnType<ManagedExportStore["publish"]>>;
    try {
      const staged = await this.stageSnapshot(operation, snapshot, entries);
      operation = this.releaseAndPackage(operation, manifest);
      operation = await this.scanCandidate(operation, manifest, staged);
      published = await this.options.managedStore.publish({
        exportId: operation.id,
        write: (output) => writeDeterministicArchive(manifest, staged, output),
        verify: (path, archive) =>
          verifyFinalizedArchive(path, manifest, archive, this.secretGate()),
      });
    } catch (error) {
      await this.failExecution(operationId, snapshot.id, error);
      throw new Error("PORTABILITY_EXPORT_EXECUTION_FAILED", { cause: error });
    }
    const ready = this.recordReady(operation, manifest, published);
    return {
      ...ready,
      stagingCleanup: await this.cleanupStaging(snapshot.id),
    };
  }

  async openDownload(input: OpenProjectExportDownloadInput) {
    const managedExport = this.managedExports.get(input.exportId);
    if (!managedExport) throw new Error("PORTABILITY_MANAGED_EXPORT_NOT_FOUND");
    if (
      managedExport.projectId !== input.projectId ||
      managedExport.customerId !== input.customerId ||
      managedExport.familyId !== input.familyId
    )
      throw new Error("PORTABILITY_MANAGED_EXPORT_SCOPE_MISMATCH");
    const operation = this.operations.get(managedExport.operationId);
    if (!operation || operation.state !== "ready")
      throw new Error("PORTABILITY_MANAGED_EXPORT_NOT_READY");
    if (!downloadRecordMatchesOperation(managedExport, operation))
      throw new Error("PORTABILITY_MANAGED_EXPORT_LINK_MISMATCH");
    return this.options.managedStore.openDownload(managedExport.archiveKey, {
      bytes: managedExport.bytes,
      sha256: managedExport.archiveChecksum,
    });
  }

  private async cleanupStaging(snapshotId: string) {
    try {
      await this.options.stagingStore.cleanup(snapshotId);
      return "complete" as const;
    } catch {
      return "pending" as const;
    }
  }

  private async stageSnapshot(
    operation: ExportOperation,
    snapshot: PortabilitySnapshot,
    entries: readonly PortabilitySnapshotEntry[],
  ) {
    const sources = snapshotArchiveSources(entries, {
      assetRoot: this.options.assets.root,
      originalRoot: this.options.originals.root,
    });
    if (operation.state !== "staging")
      return this.options.stagingStore.openStaged(snapshot.id, sources);
    if (snapshot.state === "frozen")
      this.options.store.transactionImmediate(() =>
        this.snapshots.transitionInTransaction(snapshot, {
          ...snapshot,
          state: "staging",
          revision: snapshot.revision + 1,
          updatedAt: this.nowIso(),
        }),
      );
    if (snapshot.state !== "frozen" && snapshot.state !== "staging")
      throw new Error("PORTABILITY_EXPORT_SNAPSHOT_STATE_INVALID");
    return this.options.stagingStore.stage(snapshot.id, sources);
  }

  private releaseAndPackage(
    operation: ExportOperation,
    manifest: ManifestV2,
  ): ExportOperation {
    if (operation.state !== "staging") {
      if (operation.manifestHash !== manifest.manifestHash)
        throw new Error("PORTABILITY_EXPORT_MANIFEST_MISMATCH");
      return operation;
    }
    return this.options.store.transactionImmediate(() => {
      const snapshot = this.requireSnapshot(operation);
      this.snapshots.releaseMediaHoldsInTransaction(snapshot.id, (hold) =>
        this.releaseMediaHold(hold),
      );
      const staged = this.snapshots.transitionInTransaction(snapshot, {
        ...snapshot,
        state: "staged",
        revision: snapshot.revision + 1,
        updatedAt: this.nowIso(),
      });
      this.releaseSnapshotLock(operation.id);
      this.snapshots.transitionInTransaction(staged, {
        ...staged,
        state: "released",
        revision: staged.revision + 1,
        updatedAt: this.nowIso(),
      });
      return this.operations.updateInTransaction(operation, {
        ...operation,
        state: "packaging",
        revision: operation.revision + 1,
        updatedAt: this.nowIso(),
        manifestHash: manifest.manifestHash,
      });
    });
  }

  private releaseMediaHold(hold: Readonly<PortabilityMediaHold>): void {
    const released =
      hold.namespace === "asset"
        ? this.options.assets.releaseWithoutUnlinkInTransaction(hold.mediaId)
        : this.options.originals.releaseWithoutUnlinkInTransaction(
            hold.mediaId,
          );
    if (released.cleanupIntent)
      throw new Error("PORTABILITY_EXPORT_HOLD_RELEASE_INVALID");
  }

  private releaseSnapshotLock(operationId: string): void {
    const lock = this.requireOperationLock(operationId);
    const releasing = this.admission.transitionInTransaction(
      lock.id,
      operationId,
      lock.revision,
      "releasing",
    );
    this.admission.releaseInTransaction(
      releasing.id,
      operationId,
      releasing.revision,
    );
  }

  private async scanCandidate(
    operation: ExportOperation,
    manifest: ManifestV2,
    staged: Awaited<ReturnType<SnapshotStagingStore["stage"]>>,
  ): Promise<ExportOperation> {
    if (operation.state === "secret_scanning") return operation;
    if (operation.state !== "packaging")
      throw new Error("PORTABILITY_EXPORT_STATE_INVALID");
    const finding = await scanStagedArchive(
      manifest,
      staged,
      this.secretGate(),
    );
    if (finding) throw new ManagedExportReleaseError(finding);
    return this.options.store.transactionImmediate(() =>
      this.operations.updateInTransaction(operation, {
        ...operation,
        state: "secret_scanning",
        revision: operation.revision + 1,
        updatedAt: this.nowIso(),
      }),
    );
  }

  private recordReady(
    operation: ExportOperation,
    manifest: ManifestV2,
    published: Awaited<ReturnType<ManagedExportStore["publish"]>>,
  ): ReadyProjectExportResult {
    return this.options.store.transactionImmediate(() => {
      const ready = this.operations.updateInTransaction(operation, {
        ...operation,
        state: "ready",
        revision: operation.revision + 1,
        updatedAt: this.nowIso(),
        archiveKey: published.archiveKey,
        archiveChecksum: published.archive.sha256,
        archiveBytes: published.archive.bytes,
      });
      const managedExport = this.managedExports.recordReadyInTransaction(
        ready,
        managedExportRecord(ready, this.nowIso()),
      );
      return {
        operation: ready,
        managedExport,
        manifest,
        stagingCleanup: "pending",
      };
    });
  }

  private async failExecution(
    operationId: string,
    snapshotId: string,
    error: unknown,
  ): Promise<void> {
    let cleanupState: ExportOperation["cleanupState"] = "complete";
    try {
      await this.options.stagingStore.cleanup(snapshotId);
    } catch {
      cleanupState = "failed";
    }
    this.options.store.transactionImmediate(() => {
      const operation = this.requireOperation(operationId);
      if (operation.state === "ready" || operation.state === "failed") return;
      this.releaseFailureResources(operation);
      this.operations.updateInTransaction(operation, {
        ...operation,
        state: "failed",
        revision: operation.revision + 1,
        updatedAt: this.nowIso(),
        manifestHash: null,
        archiveKey: null,
        archiveChecksum: null,
        archiveBytes: null,
        failureCode: executionFailureCode(error),
        cleanupState,
      });
    });
  }

  private releaseFailureResources(operation: ExportOperation): void {
    const snapshot = operation.snapshotId
      ? this.snapshots.get(operation.snapshotId)
      : null;
    if (snapshot?.state === "staging") {
      this.snapshots.releaseMediaHoldsInTransaction(snapshot.id, (hold) =>
        this.releaseMediaHold(hold),
      );
      this.snapshots.transitionInTransaction(snapshot, {
        ...snapshot,
        state: "failed",
        revision: snapshot.revision + 1,
        updatedAt: this.nowIso(),
        failureCode: "EXPORT_EXECUTION_FAILED",
      });
    }
    if (this.locks.list().some((lock) => lock.operationId === operation.id))
      this.releaseSnapshotLock(operation.id);
  }

  private readyResult(operation: ExportOperation): ReadyProjectExportResult {
    const managedExport = this.managedExports.forOperation(operation.id);
    const snapshot = this.requireSnapshot(operation);
    if (!managedExport) throw new Error("PORTABILITY_MANAGED_EXPORT_NOT_FOUND");
    return {
      operation,
      managedExport,
      manifest: manifestForOperation(
        operation,
        snapshot,
        this.snapshots.entries(snapshot.id),
        this.options.appVersion,
      ),
      stagingCleanup: "pending",
    };
  }

  private requireSnapshot(operation: ExportOperation): PortabilitySnapshot {
    const snapshot = operation.snapshotId
      ? this.snapshots.get(operation.snapshotId)
      : null;
    if (!snapshot) throw new Error("PORTABILITY_SNAPSHOT_NOT_FOUND");
    return snapshot;
  }

  private secretGate(): SecretReleaseGate {
    return new SecretReleaseGate(this.options.store.secretRegistry);
  }

  private startInTransaction(input: StartProjectExportInput) {
    const operation = this.requireOperation(input.operationId);
    if (
      operation.projectId !== input.projectId ||
      operation.projectRevision !== input.expectedProjectRevision ||
      operation.revision !== input.expectedOperationRevision
    )
      throw new Error("PORTABILITY_EXPORT_START_CONFLICT");
    const frozen = this.freezer.freeze({
      operationId: operation.id,
      expectedProjectRevision: input.expectedProjectRevision,
    });
    return {
      kind: "inline" as const,
      state: frozen.operation.state,
      entityIds: [frozen.operation.id, frozen.snapshot.id],
      counts: {
        documents: frozen.snapshot.documentCount,
        media: frozen.snapshot.mediaCount,
      },
      hashes: {
        snapshot: requiredHash(frozen.snapshot.snapshotHash),
        graph: frozen.graph.hash,
      },
      flags: { projectPaused: true, scopeLocked: true },
    };
  }

  private pauseInTransaction(input: PauseProjectExportInput) {
    const project = this.projects.get(input.projectId);
    if (!project) throw new Error("PORTABILITY_EXPORT_PROJECT_NOT_FOUND");
    if (project.revision !== input.expectedProjectRevision)
      throw new Error("PORTABILITY_EXPORT_PROJECT_REVISION_CONFLICT");
    const operationId = this.idFactory();
    const pausedProject = this.pauseProject(project);
    const captured = capturedProjectAttempts(
      this.options.scheduler.list(),
      project.id,
    );
    const boundary = this.captureAndLock(project, operationId, captured);
    const waiting = this.operations.insertInTransaction(
      initialOperation({
        operationId,
        project: pausedProject,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        now: this.nowIso(),
      }),
    );
    const operation = this.operations.updateInTransaction(waiting, {
      ...waiting,
      revision: waiting.revision + 1,
      updatedAt: this.nowIso(),
      state: "waiting_quiescence",
    });
    return {
      kind: "inline" as const,
      state: operation.state,
      entityIds: [operation.id, boundary.lock.id],
      counts: {
        capturedAttempts: captured.length,
        pausedJobs: boundary.pausedJobIds.length,
      },
      hashes: { capturedAttempts: boundary.ledger.rootHash },
      flags: { projectPaused: true },
    };
  }

  private pauseProject(project: Project): Project {
    if (project.paused) return project;
    return this.projects.update({
      ...project,
      paused: true,
      revision: project.revision + 1,
      updatedAt: this.nowIso(),
    });
  }

  private captureAndLock(
    project: Project,
    operationId: string,
    captured: readonly { jobId: string; attempt: number }[],
  ) {
    const pausedJobIds = this.options.scheduler.pauseProject(project.id);
    const ledger = this.capturedAttempts.writeInTransaction(
      operationId,
      captured,
    );
    const lock = this.admission.acquireManyInTransaction([
      {
        operationId,
        scope: {
          kind: "project",
          id: project.id,
          customerId: project.customerId,
          projectId: project.id,
        },
        mode: "export_snapshot",
        phase: "draining",
        capturedAttemptLedgerRoot: ledger.rootHash,
        capturedAttemptCount: ledger.entryCount,
      },
    ])[0];
    return { pausedJobIds, ledger, lock };
  }

  private requireOperation(id: string): ExportOperation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error("PORTABILITY_EXPORT_NOT_FOUND");
    return operation;
  }

  private requireOperationLock(operationId: string): PortabilityScopeLock {
    const lock = this.findOperationLock(operationId);
    if (!lock) throw new Error("PORTABILITY_EXPORT_LOCK_NOT_FOUND");
    return lock;
  }

  private findOperationLock(operationId: string): PortabilityScopeLock | null {
    return (
      this.locks.list().find((item) => item.operationId === operationId) ?? null
    );
  }

  private clockOptions() {
    return { nowIso: this.nowIso, idFactory: this.idFactory };
  }
}

export function pauseProjectExportRequestHash(
  input: Omit<PauseProjectExportInput, "requestHash">,
): string {
  return portabilityActionRequestHash(pauseActionRequest(input));
}

export function startProjectExportRequestHash(
  input: Omit<StartProjectExportInput, "requestHash">,
): string {
  return portabilityActionRequestHash(startActionRequest(input));
}

function pauseActionRequest(
  input: Omit<PauseProjectExportInput, "requestHash">,
) {
  return {
    operationScope: { kind: "project" as const, id: input.projectId },
    action: "export_pause" as const,
    input: {
      revisions: { project: input.expectedProjectRevision },
      hashes: {},
      counts: {},
      flags: {
        childPhotosAcknowledged: input.acknowledgedChildPhotos,
        noAutomaticBackupAcknowledged: input.acknowledgedNoAutomaticBackup,
      },
    },
  };
}

function startActionRequest(
  input: Omit<StartProjectExportInput, "requestHash">,
) {
  return {
    operationScope: { kind: "project" as const, id: input.projectId },
    action: "export_start" as const,
    input: {
      revisions: {
        project: input.expectedProjectRevision,
        operation: input.expectedOperationRevision,
      },
      hashes: { operationId: hashOpaqueId(input.operationId) },
      counts: {},
      flags: { pauseConfirmed: true },
    },
  };
}

function hashOpaqueId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function downloadRecordMatchesOperation(
  record: ManagedExport,
  operation: ExportOperation,
): boolean {
  return (
    record.exportId === operation.id &&
    record.operationId === operation.id &&
    record.projectId === operation.projectId &&
    record.customerId === operation.customerId &&
    record.familyId === operation.familyId &&
    record.snapshotHash === operation.snapshotHash &&
    record.manifestHash === operation.manifestHash &&
    record.archiveKey === operation.archiveKey &&
    record.archiveChecksum === operation.archiveChecksum &&
    record.bytes === operation.archiveBytes
  );
}
