import { ulid } from "ulid";

import type { AssetRecord, AssetStore } from "../../assets/asset-store.js";
import type {
  OriginalAssetRecord,
  OriginalAssetStore,
} from "../../assets/original-asset-store.js";
import { JobRepository } from "../../jobs/repository.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { Project } from "../authoring/schemas.js";
import type { DocumentStore } from "../repository/document-store.js";
import type {
  ExportOperation,
  PortabilityMediaInput,
  PortabilitySnapshot,
  PortabilitySnapshotEntry,
} from "./export-model.js";
import {
  ExportOperationRepository,
  PortabilitySnapshotRepository,
} from "./export-storage.js";
import {
  selectPortabilityGraph,
  type PortabilityGraphSelection,
  type SelectedPortabilityDocument,
  type SelectedPortabilityMedia,
} from "./graph.js";
import type { PortabilityRegistry } from "./participants.js";
import {
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
} from "./repositories.js";
import { ScopeAdmissionService } from "./scope-locks.js";
import type { PortabilityScopeLock } from "./schemas.js";

export interface ProjectSnapshotFreezerOptions {
  store: DocumentStore;
  registry: PortabilityRegistry;
  assets: AssetStore;
  originals: OriginalAssetStore;
  nowIso?: () => string;
  idFactory?: () => string;
}

export interface FreezeProjectSnapshotInput {
  operationId: string;
  expectedProjectRevision: number;
}

export interface ProjectSnapshotFreezeResult {
  operation: ExportOperation;
  snapshot: PortabilitySnapshot;
  lock: PortabilityScopeLock;
  graph: PortabilityGraphSelection;
}

interface DocumentEntryPlan {
  kind: "document";
  archiveEntry: string;
  selected: SelectedPortabilityDocument;
}

interface MediaEntryPlan {
  kind: "media";
  archiveEntry: string;
  input: PortabilityMediaInput;
}

type SnapshotEntryPlan = DocumentEntryPlan | MediaEntryPlan;

interface StoredRow {
  doc: string;
}

export class ProjectSnapshotFreezer {
  private readonly nowIso: () => string;
  private readonly idFactory: () => string;
  private readonly projects: AuthoringRepositories["projects"];
  private readonly jobs: JobRepository;
  private readonly operations: ExportOperationRepository;
  private readonly snapshotRepository: PortabilitySnapshotRepository;
  private readonly locks: PortabilityScopeLockRepository;
  private readonly ledgers: PortabilityLedgerRepository;
  private readonly admission: ScopeAdmissionService;

  constructor(private readonly options: ProjectSnapshotFreezerOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.projects = new AuthoringRepositories(options.store).projects;
    this.jobs = new JobRepository(options.store);
    this.operations = new ExportOperationRepository(options.store);
    this.snapshotRepository = new PortabilitySnapshotRepository(
      options.store,
      options.registry,
      this.clockOptions(),
    );
    this.locks = new PortabilityScopeLockRepository(options.store);
    this.ledgers = new PortabilityLedgerRepository(options.store);
    this.admission = new ScopeAdmissionService(
      options.store,
      this.locks,
      this.ledgers,
      this.clockOptions(),
    );
  }

  freeze(input: FreezeProjectSnapshotInput): ProjectSnapshotFreezeResult {
    assertExpectedRevision(input.expectedProjectRevision);
    return this.options.store.transactionImmediate(() =>
      this.freezeInTransaction(input),
    );
  }

  private freezeInTransaction(
    input: FreezeProjectSnapshotInput,
  ): ProjectSnapshotFreezeResult {
    const operation = this.requireOperation(input.operationId);
    const project = this.requirePausedProject(operation, input);
    if (operation.state === "staging")
      return this.replayFrozen(operation, project);
    if (operation.state !== "waiting_quiescence")
      fail("PORTABILITY_EXPORT_OPERATION_STATE_INVALID");
    const draining = this.requireLock(operation, "draining");
    this.assertQuiescent(operation.projectId);
    const acquiring = this.advanceOperation(operation, "acquiring_lock");
    const lock = this.admission.transitionInTransaction(
      draining.id,
      operation.id,
      draining.revision,
      "snapshot",
    );
    const graph = this.selectGraph(operation);
    return this.createFrozenSnapshot(acquiring, project, lock, graph);
  }

  private createFrozenSnapshot(
    operation: ExportOperation,
    project: Project,
    lock: PortabilityScopeLock,
    graph: PortabilityGraphSelection,
  ): ProjectSnapshotFreezeResult {
    const snapshotId = this.idFactory();
    const freezing = this.advanceOperation(operation, "freezing_snapshot", {
      snapshotId,
    });
    this.snapshotRepository.createInTransaction(
      initialSnapshot(
        snapshotId,
        freezing,
        project,
        this.options.registry.hash,
        this.nowIso(),
      ),
    );
    for (const plan of this.entryPlans(graph))
      this.appendPlan(snapshotId, plan);
    const snapshot = this.snapshotRepository.freezeInTransaction(snapshotId);
    const staged = this.advanceOperation(freezing, "staging", {
      snapshotHash: requiredHash(snapshot.snapshotHash),
      documentCount: snapshot.documentCount,
      mediaCount: snapshot.mediaCount,
      totalUncompressedBytes: snapshot.totalUncompressedBytes,
    });
    return { operation: staged, snapshot, lock, graph };
  }

  private replayFrozen(
    operation: ExportOperation,
    project: Project,
  ): ProjectSnapshotFreezeResult {
    const lock = this.requireLock(operation, "snapshot");
    const snapshot = operation.snapshotId
      ? this.snapshotRepository.get(operation.snapshotId)
      : null;
    if (!snapshot) fail("PORTABILITY_EXPORT_SNAPSHOT_LINK_MISMATCH");
    assertSnapshotLinkage(operation, project, snapshot, this.options.registry);
    const verified = this.snapshotRepository.freezeInTransaction(snapshot.id);
    const graph = this.selectGraph(operation);
    assertEntriesMatchGraph(
      this.snapshotRepository.entries(snapshot.id),
      graph,
    );
    return { operation, snapshot: verified, lock, graph };
  }

  private entryPlans(graph: PortabilityGraphSelection): SnapshotEntryPlan[] {
    const documents = graph.documents.map(documentPlan);
    const media = graph.media.map((selected) =>
      selected.namespace === "asset"
        ? assetPlan(selected, this.requireAsset(selected.id))
        : originalPlan(selected, this.requireOriginal(selected.id)),
    );
    return [...documents, ...media].sort((left, right) =>
      left.archiveEntry.localeCompare(right.archiveEntry),
    );
  }

  private appendPlan(snapshotId: string, plan: SnapshotEntryPlan): void {
    if (plan.kind === "document") {
      this.snapshotRepository.appendDocumentInTransaction(snapshotId, {
        collection: plan.selected.collection,
        document: plan.selected.document,
        reasons: plan.selected.reasons,
      });
      return;
    }
    const store =
      plan.input.namespace === "asset"
        ? this.options.assets
        : this.options.originals;
    const held = store.holdInTransaction(plan.input.mediaId, () => {
      this.snapshotRepository.appendMediaInTransaction(snapshotId, plan.input);
      return "acquired";
    });
    if (!held.acquired) fail("PORTABILITY_EXPORT_MEDIA_HOLD_REPLAY_INVALID");
  }

  private selectGraph(operation: ExportOperation): PortabilityGraphSelection {
    return selectPortabilityGraph({
      registry: this.options.registry,
      documents: participantDocuments(
        this.options.store,
        this.options.registry,
      ),
      root: {
        kind: "project",
        projectId: operation.projectId,
        customerId: operation.customerId,
        familyId: operation.familyId,
      },
    });
  }

  private requireOperation(operationId: string): ExportOperation {
    const operation = this.operations.get(operationId);
    if (!operation) fail("PORTABILITY_EXPORT_NOT_FOUND");
    return operation;
  }

  private requirePausedProject(
    operation: ExportOperation,
    input: FreezeProjectSnapshotInput,
  ): Project {
    const project = this.projects.get(operation.projectId);
    if (!project) fail("PORTABILITY_EXPORT_PROJECT_NOT_FOUND");
    if (
      input.expectedProjectRevision !== operation.projectRevision ||
      project.revision !== operation.projectRevision
    )
      fail("PORTABILITY_EXPORT_PROJECT_REVISION_CONFLICT");
    if (!project.paused) fail("PORTABILITY_EXPORT_PROJECT_NOT_PAUSED");
    if (
      project.customerId !== operation.customerId ||
      project.familyId !== operation.familyId
    )
      fail("PORTABILITY_EXPORT_PROJECT_SCOPE_MISMATCH");
    return project;
  }

  private requireLock(
    operation: ExportOperation,
    phase: "draining" | "snapshot",
  ): PortabilityScopeLock {
    const matches = this.locks
      .list()
      .filter((candidate) => candidate.operationId === operation.id);
    const lock = matches.length === 1 ? matches[0] : null;
    if (!lock) fail("PORTABILITY_EXPORT_LOCK_NOT_FOUND");
    if (
      lock.mode !== "export_snapshot" ||
      lock.phase !== phase ||
      lock.scope.kind !== "project" ||
      lock.scope.id !== operation.projectId ||
      lock.scope.projectId !== operation.projectId ||
      lock.scope.customerId !== operation.customerId
    )
      fail("PORTABILITY_EXPORT_LOCK_MISMATCH");
    const captured = this.ledgers.root(operation.id, "captured_attempts");
    if (
      captured.rootHash !== lock.capturedAttemptLedgerRoot ||
      captured.entryCount !== lock.capturedAttemptCount
    )
      fail("PORTABILITY_EXPORT_LOCK_MISMATCH");
    return lock;
  }

  private assertQuiescent(projectId: string): void {
    if (
      this.jobs
        .list()
        .some(
          (job) =>
            job.projectId === projectId &&
            (job.state === "claimed" || job.state === "running"),
        )
    )
      fail("PORTABILITY_EXPORT_NOT_QUIESCENT");
  }

  private advanceOperation(
    current: ExportOperation,
    state: ExportOperation["state"],
    fields: Partial<ExportOperation> = {},
  ): ExportOperation {
    return this.operations.updateInTransaction(current, {
      ...current,
      ...fields,
      state,
      revision: current.revision + 1,
      updatedAt: this.nowIso(),
    });
  }

  private requireAsset(id: string): AssetRecord {
    const record = this.options.assets.get(id);
    if (!record) fail("PORTABILITY_EXPORT_ASSET_NOT_FOUND");
    return record;
  }

  private requireOriginal(id: string): OriginalAssetRecord {
    const record = this.options.originals.get(id);
    if (!record) fail("PORTABILITY_EXPORT_ORIGINAL_NOT_FOUND");
    return record;
  }

  private clockOptions() {
    return { nowIso: this.nowIso, idFactory: this.idFactory };
  }
}

function initialSnapshot(
  id: string,
  operation: ExportOperation,
  project: Project,
  participantRegistryHash: string,
  now: string,
): PortabilitySnapshot {
  return {
    id,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    operationId: operation.id,
    projectId: project.id,
    customerId: project.customerId,
    familyId: project.familyId,
    projectRevision: project.revision,
    participantRegistryHash,
    state: "freezing",
    documentCount: 0,
    mediaCount: 0,
    totalUncompressedBytes: 0,
    documentRootHash: null,
    mediaRootHash: null,
    snapshotHash: null,
    nextOrdinal: 0,
    failureCode: null,
  };
}

function participantDocuments(
  store: DocumentStore,
  registry: PortabilityRegistry,
) {
  return registry.catalog.collections
    .filter((entry) => entry.owner === "participant")
    .flatMap((entry) => {
      registry.forCollection(entry.key);
      const rows = store.database
        .prepare("SELECT doc FROM documents WHERE collection = ? ORDER BY id")
        .all(entry.key) as StoredRow[];
      return rows.map((row) => {
        const document: unknown = JSON.parse(row.doc);
        store.assertSafeForPersistence(document);
        return { collection: entry.key, document };
      });
    });
}

function documentPlan(
  selected: SelectedPortabilityDocument,
): DocumentEntryPlan {
  return {
    kind: "document",
    archiveEntry: `data/${selected.collection}/${selected.id}.json`,
    selected,
  };
}

function assetPlan(
  selected: SelectedPortabilityMedia,
  record: AssetRecord,
): MediaEntryPlan {
  return mediaPlan(selected, record.refCount, {
    namespace: "asset",
    mediaId: record.id,
    role: record.role,
    mime: record.mime,
    extension: record.extension,
    bytes: record.bytes,
    sha256: record.sha256,
  });
}

function originalPlan(
  selected: SelectedPortabilityMedia,
  record: OriginalAssetRecord,
): MediaEntryPlan {
  return mediaPlan(selected, record.refCount, {
    namespace: "original",
    mediaId: record.id,
    role: "reference_photo",
    mime: record.sourceMime,
    extension: record.extension,
    bytes: record.bytes,
    sha256: record.sha256,
  });
}

function mediaPlan(
  selected: SelectedPortabilityMedia,
  preHoldRefCount: number,
  metadata: Omit<
    PortabilityMediaInput,
    | "occurrenceCount"
    | "ownedCount"
    | "referencedCount"
    | "outsideScopeOccurrenceCount"
    | "preHoldRefCount"
    | "disposition"
  >,
): MediaEntryPlan {
  const input: PortabilityMediaInput = {
    ...metadata,
    occurrenceCount: selected.occurrenceCount,
    ownedCount: selected.ownedCount,
    referencedCount: selected.referencedCount,
    outsideScopeOccurrenceCount: selected.outsideScopeOccurrenceCount,
    preHoldRefCount,
    disposition:
      selected.outsideScopeOccurrenceCount === 0
        ? "scope_only"
        : "shared_reference_preserved",
  };
  const directory = input.namespace === "asset" ? "assets" : "originals";
  return {
    kind: "media",
    archiveEntry: `media/${directory}/${input.sha256}.${input.extension}`,
    input,
  };
}

function assertSnapshotLinkage(
  operation: ExportOperation,
  project: Project,
  snapshot: PortabilitySnapshot,
  registry: PortabilityRegistry,
): void {
  if (
    snapshot.state !== "frozen" ||
    snapshot.operationId !== operation.id ||
    snapshot.projectId !== project.id ||
    snapshot.customerId !== project.customerId ||
    snapshot.familyId !== project.familyId ||
    snapshot.projectRevision !== project.revision ||
    snapshot.participantRegistryHash !== registry.hash ||
    snapshot.snapshotHash !== operation.snapshotHash ||
    snapshot.documentCount !== operation.documentCount ||
    snapshot.mediaCount !== operation.mediaCount ||
    snapshot.totalUncompressedBytes !== operation.totalUncompressedBytes
  )
    fail("PORTABILITY_EXPORT_SNAPSHOT_LINK_MISMATCH");
}

function assertEntriesMatchGraph(
  entries: readonly PortabilitySnapshotEntry[],
  graph: PortabilityGraphSelection,
): void {
  const documents = entries
    .filter((entry) => entry.entryType === "document")
    .map((entry) => `${entry.collection}:${entry.documentId}`)
    .sort();
  const selectedDocuments = graph.documents
    .map((entry) => `${entry.collection}:${entry.id}`)
    .sort();
  const media = entries
    .filter((entry) => entry.entryType === "media")
    .map(snapshotMediaGraphIdentity)
    .sort(compareMediaIdentity);
  const selectedMedia = graph.media
    .map(selectedMediaGraphIdentity)
    .sort(compareMediaIdentity);
  if (
    JSON.stringify(documents) !== JSON.stringify(selectedDocuments) ||
    JSON.stringify(media) !== JSON.stringify(selectedMedia)
  )
    fail("PORTABILITY_EXPORT_SNAPSHOT_LINK_MISMATCH");
}

function snapshotMediaGraphIdentity(
  entry: Extract<PortabilitySnapshotEntry, { entryType: "media" }>,
) {
  return {
    namespace: entry.namespace,
    id: entry.mediaId,
    occurrenceCount: entry.occurrenceCount,
    ownedCount: entry.ownedCount,
    referencedCount: entry.referencedCount,
    outsideScopeOccurrenceCount: entry.outsideScopeOccurrenceCount,
  };
}

function selectedMediaGraphIdentity(entry: SelectedPortabilityMedia) {
  return {
    namespace: entry.namespace,
    id: entry.id,
    occurrenceCount: entry.occurrenceCount,
    ownedCount: entry.ownedCount,
    referencedCount: entry.referencedCount,
    outsideScopeOccurrenceCount: entry.outsideScopeOccurrenceCount,
  };
}

function compareMediaIdentity(
  left: ReturnType<typeof selectedMediaGraphIdentity>,
  right: ReturnType<typeof selectedMediaGraphIdentity>,
): number {
  return `${left.namespace}:${left.id}`.localeCompare(
    `${right.namespace}:${right.id}`,
  );
}

function assertExpectedRevision(value: number): void {
  if (!Number.isInteger(value) || value < 0)
    fail("PORTABILITY_EXPORT_PROJECT_REVISION_CONFLICT");
}

function requiredHash(value: string | null): string {
  if (!value) fail("PORTABILITY_EXPORT_SNAPSHOT_LINK_MISMATCH");
  return value;
}

function fail(code: string): never {
  throw new Error(code);
}
