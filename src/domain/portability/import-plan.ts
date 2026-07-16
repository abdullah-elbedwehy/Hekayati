import { createHash } from "node:crypto";

import { ulid } from "ulid";

import { canonicalJson } from "../../contracts/canonical-json.js";
import type { DocumentStore } from "../repository/document-store.js";
import { lookupExactId } from "./id-map.js";
import { allocateImportIds } from "./import-plan-allocation.js";
import { compileImportPlan } from "./import-plan-compile.js";
import {
  appendImportLedgerPages,
  importPlanLedgerRoot,
  previewImportLedgerRoot,
  type ImportLedgerKind,
} from "./import-ledger-pages.js";
import {
  hashImportPlanConfirmation,
  importPlanRequestSchema,
  importPlanSchema,
  type ImportPlan,
  type ImportPlanCore,
  type ImportPlanLedgerRoots,
  type ImportPlanRequest,
} from "./import-plan-model.js";
import {
  selectImportBundle,
  type ImportPlanSourceBundle,
} from "./import-plan-selection.js";
import type { ImportPlanRepository } from "./import-plan-storage.js";
import type { ImportPlanTargetReader } from "./import-plan-target.js";
import type { ImportOperation } from "./import-model.js";
import type { ImportOperationRepository } from "./import-storage.js";
import {
  PortabilityActionBoundary,
  portabilityActionRequestHash,
  type PortabilityActionIdentity,
  type PortabilityActionBoundaryInput,
} from "./operation-ledgers.js";
import type { PortabilityRegistry } from "./participants.js";
import type {
  PortabilityActionRepository,
  PortabilityLedgerRepository,
} from "./repositories.js";
import { PortabilityStorageError } from "./repositories.js";
import type {
  PortabilityAction,
  PortabilityActionResult,
  PortabilityLedgerEntry,
} from "./schemas.js";

export interface ImportPlanServiceOptions {
  readonly nowIso?: () => string;
  readonly idFactory?: () => string;
}

export interface ImportPlanResult {
  readonly plan: ImportPlan;
  readonly action: PortabilityAction;
  readonly current: ImportOperation;
  readonly replayed: boolean;
}

interface PlanLedgerEntries {
  readonly import_id_map: readonly PortabilityLedgerEntry[];
  readonly import_conflicts: readonly PortabilityLedgerEntry[];
  readonly import_writes: readonly PortabilityLedgerEntry[];
  readonly import_releases: readonly PortabilityLedgerEntry[];
  readonly import_rebases: readonly PortabilityLedgerEntry[];
  readonly prepared_media: readonly PortabilityLedgerEntry[];
  readonly import_authorizations: readonly PortabilityLedgerEntry[];
}

interface PreparedImportPlan {
  readonly id: string;
  readonly request: ImportPlanRequest;
  readonly allocation: ReturnType<typeof allocateImportIds>;
  readonly compiled: ReturnType<typeof compileImportPlan>;
  readonly entries: PlanLedgerEntries;
  readonly previewRoots: ImportPlanLedgerRoots;
}

const ledgerKinds: readonly ImportLedgerKind[] = [
  "import_id_map",
  "import_conflicts",
  "import_writes",
  "import_releases",
  "import_rebases",
  "prepared_media",
  "import_authorizations",
];

export class ImportPlanService {
  readonly #boundary: PortabilityActionBoundary;
  readonly #idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    private readonly operations: ImportOperationRepository,
    private readonly plans: ImportPlanRepository,
    private readonly actions: PortabilityActionRepository,
    private readonly ledgers: PortabilityLedgerRepository,
    private readonly registry: PortabilityRegistry,
    private readonly target: ImportPlanTargetReader,
    options: ImportPlanServiceOptions = {},
  ) {
    this.#idFactory = options.idFactory ?? ulid;
    this.#boundary = new PortabilityActionBoundary(store, actions, options);
  }

  plan(
    operationId: string,
    requestValue: unknown,
    source: ImportPlanSourceBundle,
  ): ImportPlanResult {
    const request = importPlanRequestSchema.parse(requestValue);
    const operation = this.requireOperation(operationId);
    assertPinnedSource(operation, request, source, this.registry);
    const boundaryInput = planBoundaryInput(operation, request, source);
    const replay = this.precheckReplay(boundaryInput);
    if (replay) return replay;
    const prepared = this.prepareNewPlan(operation, request, source);
    const boundary = this.#boundary.run(boundaryInput, (identity) =>
      this.persistPreparedPlan(operationId, source, prepared, identity),
    );
    return this.resultFromAction(boundary.action, boundary.replayed);
  }

  private prepareNewPlan(
    operation: ImportOperation,
    request: ImportPlanRequest,
    source: ImportPlanSourceBundle,
  ): PreparedImportPlan {
    assertPlanningRevision(operation, request);
    assertTargetEvidence(request, this.target);
    const selected = selectImportBundle({
      request,
      source,
      registry: this.registry,
    });
    const allocation = allocateImportIds({
      request,
      source,
      selected,
      registry: this.registry,
      target: this.target,
      idFactory: this.#idFactory,
    });
    const compiled = compileImportPlan({
      request,
      source,
      selected,
      allocation,
      registry: this.registry,
      target: this.target,
    });
    const entries = planLedgerEntries(allocation, compiled);
    const id = this.#idFactory();
    return {
      id,
      request,
      allocation,
      compiled,
      entries,
      previewRoots: previewRootsFor(id, entries),
    };
  }

  private persistPreparedPlan(
    operationId: string,
    source: ImportPlanSourceBundle,
    prepared: PreparedImportPlan,
    identity: PortabilityActionIdentity,
  ) {
    const current = this.requireOperation(operationId);
    assertPlanningRevision(current, prepared.request);
    assertPinnedSource(current, prepared.request, source, this.registry);
    assertTargetEvidence(prepared.request, this.target);
    const roots = appendLedgers({
      store: this.store,
      repository: this.ledgers,
      planId: prepared.id,
      entries: prepared.entries,
      nowIso: identity.recordedAt,
      idFactory: this.#idFactory,
    });
    assertRootsEqual(roots, prepared.previewRoots);
    const plan = completePlan({
      id: prepared.id,
      at: identity.recordedAt,
      operation: current,
      request: prepared.request,
      source,
      allocation: prepared.allocation,
      compiled: prepared.compiled,
      roots,
    });
    this.plans.insertInTransaction(plan);
    this.bindOperationToPlan(current, plan, identity);
    return planActionEffect(plan);
  }

  private bindOperationToPlan(
    current: ImportOperation,
    plan: ImportPlan,
    identity: PortabilityActionIdentity,
  ): void {
    this.operations.replaceInTransaction(
      {
        ...current,
        revision: current.revision + 1,
        updatedAt: identity.recordedAt,
        mode: plan.mode,
        planId: plan.id,
        actionRefs: {
          ...current.actionRefs,
          latestPlanActionId: identity.id,
        },
      },
      current.revision,
    );
  }

  private precheckReplay(
    input: PortabilityActionBoundaryInput,
  ): ImportPlanResult | null {
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
    return this.resultFromAction(existing, true);
  }

  private resultFromAction(
    action: PortabilityAction,
    replayed: boolean,
  ): ImportPlanResult {
    if (action.result.kind !== "inline" || action.result.entityIds.length !== 1)
      throw new Error("IMPORT_PLAN_ACTION_RESULT_INVALID");
    const plan = this.plans.get(action.result.entityIds[0]);
    if (!plan) throw new Error("IMPORT_PLAN_ACTION_PLAN_MISSING");
    const current = this.requireOperation(plan.operationId);
    return { plan, action, current, replayed };
  }

  private requireOperation(id: string): ImportOperation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error("IMPORT_OPERATION_NOT_FOUND");
    return operation;
  }
}

function planLedgerEntries(
  allocation: ReturnType<typeof allocateImportIds>,
  compiled: ReturnType<typeof compileImportPlan>,
): PlanLedgerEntries {
  return {
    import_id_map: allocation.mappings,
    import_conflicts: allocation.conflicts,
    import_writes: compiled.writes,
    import_releases: compiled.releases,
    import_rebases: compiled.rebases,
    prepared_media: compiled.preparedMedia,
    import_authorizations: compiled.authorizations,
  };
}

function planActionEffect(plan: ImportPlan): PortabilityActionResult {
  return {
    kind: "inline",
    state: "plan_ready",
    entityIds: [plan.id],
    counts: {
      mappings: plan.counts.mappings,
      writes: plan.counts.writes,
      preparedMedia: plan.counts.preparedMedia,
    },
    hashes: {
      plan: hash(plan),
      confirmation: plan.confirmationHash,
    },
    flags: {
      approvalPreserved: plan.counts.approvalsPreserved > 0,
      approvalDemoted: plan.counts.approvalsDemoted > 0,
    },
  };
}

export function assertImportPlanConfirmation(
  plan: Readonly<ImportPlan>,
  confirmationHash: string,
): void {
  if (plan.confirmationHash !== confirmationHash)
    throw new Error("IMPORT_PLAN_CONFIRMATION_REQUIRED");
  importPlanSchema.parse(plan);
}

export function planBoundaryInput(
  operation: ImportOperation,
  request: ImportPlanRequest,
  source: ImportPlanSourceBundle,
): PortabilityActionBoundaryInput {
  const input = {
    operationScope: { kind: "import_operation" as const, id: operation.id },
    action: "import_plan" as const,
    idempotencyKey: request.idempotencyKey,
    input: planBoundaryFacts(operation, request, source),
  };
  return { ...input, requestHash: portabilityActionRequestHash(input) };
}

function planBoundaryFacts(
  operation: ImportOperation,
  request: ImportPlanRequest,
  source: ImportPlanSourceBundle,
) {
  const resolution = request.customerResolution;
  return {
    revisions: {
      operation: request.expectedOperationRevision,
      ...(request.replaceTarget
        ? { targetProject: request.replaceTarget.projectRevision }
        : {}),
    },
    hashes: planBoundaryHashes(operation, request, source),
    counts: {
      sourceDocuments: source.documents.length,
      sourceMedia: source.media.length,
      selectedCharacters: request.selectedCharacterIds.length,
      selectedTemplates: request.selectedTemplateIds.length,
      explicitMappings: request.explicitMappings.length,
    },
    flags: {
      sameCustomerAttested:
        resolution?.kind === "map_existing_same_customer" &&
        resolution.sameRealCustomerAttested,
      destructiveScopeConfirmed:
        request.replaceTarget?.destructiveScopeConfirmed ?? false,
      preserveApproval: request.approvalPolicy === "preserve_if_proven",
    },
  };
}

function planBoundaryHashes(
  operation: ImportOperation,
  request: ImportPlanRequest,
  source: ImportPlanSourceBundle,
): Record<string, string> {
  const hashes: Record<string, string> = {
    archive: operation.sourceArchiveHash,
    manifest: requiredHash(operation.normalizedManifestHash),
    snapshot: source.sourceSnapshotHash,
    registry: operation.participantRegistryHash ?? "",
    graph: source.graphHash,
    request: hash(request),
    disk: hash(operation.diskFacts),
    migration: hash(operation.migrationSummary),
  };
  const resolution = request.customerResolution;
  if (resolution?.kind === "map_existing_same_customer") {
    hashes.customerRevision = resolution.targetCustomerRevisionHash;
    hashes.familyRevision = resolution.targetFamilyRevisionHash;
  }
  if (request.replaceTarget)
    hashes.projectRevision = request.replaceTarget.projectRevisionHash;
  if (request.templateCatalogRevisionHash)
    hashes.templateCatalog = request.templateCatalogRevisionHash;
  return hashes;
}

function assertPinnedSource(
  operation: ImportOperation,
  request: ImportPlanRequest,
  source: ImportPlanSourceBundle,
  registry: PortabilityRegistry,
): void {
  if (
    operation.normalizedManifestHash === null ||
    operation.sourceSnapshotHash !== source.sourceSnapshotHash ||
    operation.participantRegistryHash !== registry.hash ||
    source.documents.length !== operation.documentCount ||
    source.media.length !== operation.mediaCount ||
    source.root.projectId !== request.sourceRoot.projectId ||
    source.root.customerId !== request.sourceRoot.customerId ||
    source.root.familyId !== request.sourceRoot.familyId
  )
    throw new Error("IMPORT_PLAN_SOURCE_FACT_MISMATCH");
  for (const [collection, id] of [
    ["projects", source.root.projectId],
    ["customers", source.root.customerId],
    ["families", source.root.familyId],
  ] as const)
    if (
      !source.documents.some(
        (item) => item.collection === collection && item.id === id,
      )
    )
      throw new Error("IMPORT_PLAN_SOURCE_ROOT_MISSING");
}

function assertPlanningRevision(
  operation: ImportOperation,
  request: ImportPlanRequest,
): void {
  if (
    operation.state !== "plan_ready" ||
    operation.revision !== request.expectedOperationRevision
  )
    throw new Error("IMPORT_OPERATION_REVISION_CONFLICT");
}

function assertTargetEvidence(
  request: ImportPlanRequest,
  target: ImportPlanTargetReader,
): void {
  assertCustomerTarget(request, target);
  assertReplaceTarget(request, target);
  if (
    request.templateCatalogRevisionHash &&
    target.templateCatalogRevisionHash() !== request.templateCatalogRevisionHash
  )
    throw new Error("IMPORT_PLAN_TEMPLATE_CATALOG_STALE");
  for (const mapping of request.explicitMappings)
    assertRevision(
      target,
      collectionForNamespace(mapping.namespace),
      mapping.targetId,
      mapping.targetRevisionHash,
    );
}

function assertCustomerTarget(
  request: ImportPlanRequest,
  target: ImportPlanTargetReader,
): void {
  const resolution = request.customerResolution;
  if (resolution?.kind !== "map_existing_same_customer") return;
  assertRevision(
    target,
    "customers",
    resolution.targetCustomerId,
    resolution.targetCustomerRevisionHash,
  );
  assertRevision(
    target,
    "families",
    resolution.targetFamilyId,
    resolution.targetFamilyRevisionHash,
  );
  const family = target.document("families", resolution.targetFamilyId);
  if (field(family, "customerId") !== resolution.targetCustomerId)
    throw new Error("IMPORT_PLAN_TARGET_OWNER_MISMATCH");
}

function assertReplaceTarget(
  request: ImportPlanRequest,
  target: ImportPlanTargetReader,
): void {
  const replacement = request.replaceTarget;
  if (!replacement) return;
  assertRevision(
    target,
    "projects",
    replacement.projectId,
    replacement.projectRevisionHash,
  );
  const resolution = request.customerResolution;
  const project = target.document("projects", replacement.projectId);
  if (
    field(project, "revision") !== replacement.projectRevision ||
    resolution?.kind !== "map_existing_same_customer" ||
    field(project, "customerId") !== resolution.targetCustomerId ||
    field(project, "familyId") !== resolution.targetFamilyId
  )
    throw new Error("IMPORT_PLAN_REPLACE_TARGET_MISMATCH");
}

function completePlan(input: {
  id: string;
  at: string;
  operation: ImportOperation;
  request: ImportPlanRequest;
  source: ImportPlanSourceBundle;
  allocation: ReturnType<typeof allocateImportIds>;
  compiled: ReturnType<typeof compileImportPlan>;
  roots: ImportPlanLedgerRoots;
}): ImportPlan {
  const core: ImportPlanCore = {
    id: input.id,
    schemaVersion: 1,
    createdAt: input.at,
    updatedAt: input.at,
    operationId: input.operation.id,
    operationRevision: input.operation.revision,
    mode: input.request.mode,
    source: planSource(input),
    target: planTarget(input),
    customerResolution: plannedCustomerResolution(input.request),
    conflictChoicesHash: planConflictChoicesHash(input),
    diskFactsHash: hash(input.operation.diskFacts),
    migrationFactsHash: hash(input.operation.migrationSummary),
    sanitizationFactsHash: input.compiled.sanitizationFactsHash,
    counts: planCounts(input),
    ledgerRoots: input.roots,
  };
  return importPlanSchema.parse({
    ...core,
    confirmationHash: hashImportPlanConfirmation(core),
  });
}

type CompletePlanInput = Parameters<typeof completePlan>[0];

function planSource(input: CompletePlanInput): ImportPlanCore["source"] {
  return {
    archiveHash: input.operation.sourceArchiveHash,
    normalizedManifestHash: requiredHash(
      input.operation.normalizedManifestHash,
    ),
    snapshotHash: input.source.sourceSnapshotHash,
    participantRegistryHash: requiredHash(
      input.operation.participantRegistryHash,
    ),
    graphHash: input.source.graphHash,
    projectId: input.source.root.projectId,
    customerId: input.source.root.customerId,
    familyId: input.source.root.familyId,
  };
}

function planConflictChoicesHash(input: CompletePlanInput): string {
  return hash({
    mode: input.request.mode,
    explicitMappings: input.request.explicitMappings,
    mappings: input.allocation.mappings,
  });
}

function planCounts(input: CompletePlanInput): ImportPlanCore["counts"] {
  return {
    mappings: input.allocation.mappings.length,
    conflicts: input.allocation.conflicts.length,
    writes: input.compiled.writes.length,
    releases: input.compiled.releases.length,
    rebases: input.compiled.rebases.length,
    preparedMedia: input.compiled.preparedMedia.length,
    authorizations: input.compiled.authorizations.length,
    approvalsPreserved: input.compiled.approvalsPreserved,
    approvalsDemoted: input.compiled.approvalsDemoted,
    jobsPaused: input.compiled.jobsPaused,
  };
}

function planTarget(input: CompletePlanInput): ImportPlanCore["target"] {
  const resolution = input.request.customerResolution;
  return {
    kind: planTargetKind(input.request.mode),
    customerId: resolution
      ? requiredMappedId(
          input.allocation.idMap,
          "customers",
          input.source.root.customerId,
        )
      : null,
    familyId: resolution
      ? requiredMappedId(
          input.allocation.idMap,
          "families",
          input.source.root.familyId,
        )
      : null,
    projectId: projectMode(input.request.mode)
      ? requiredMappedId(
          input.allocation.idMap,
          "projects",
          input.source.root.projectId,
        )
      : null,
    customerRevisionHash:
      resolution?.kind === "map_existing_same_customer"
        ? resolution.targetCustomerRevisionHash
        : null,
    familyRevisionHash:
      resolution?.kind === "map_existing_same_customer"
        ? resolution.targetFamilyRevisionHash
        : null,
    projectRevision: input.request.replaceTarget?.projectRevision ?? null,
    projectRevisionHash:
      input.request.replaceTarget?.projectRevisionHash ?? null,
    templateCatalogRevisionHash: input.request.templateCatalogRevisionHash,
  };
}

function planTargetKind(
  mode: ImportPlanRequest["mode"],
): ImportPlanCore["target"]["kind"] {
  if (mode === "as_new_project") return "new_project";
  if (mode === "replace_existing") return "replace_project";
  return mode === "characters_only" ? "character_library" : "template_catalog";
}

function plannedCustomerResolution(
  request: ImportPlanRequest,
): ImportPlanCore["customerResolution"] {
  if (!request.customerResolution)
    return { kind: "not_applicable", attestationHash: null };
  if (request.customerResolution.kind === "create_from_archive")
    return { kind: "create_from_archive", attestationHash: null };
  return {
    kind: "map_existing_same_customer",
    attestationHash: hash(request.customerResolution),
  };
}

function previewRootsFor(
  planId: string,
  entries: PlanLedgerEntries,
): ImportPlanLedgerRoots {
  return rootsFrom((kind) =>
    importPlanLedgerRoot(previewImportLedgerRoot(planId, kind, entries[kind])),
  );
}

function appendLedgers(input: {
  store: DocumentStore;
  repository: PortabilityLedgerRepository;
  planId: string;
  entries: PlanLedgerEntries;
  nowIso: string;
  idFactory: () => string;
}): ImportPlanLedgerRoots {
  return rootsFrom((kind) =>
    importPlanLedgerRoot(
      appendImportLedgerPages({
        store: input.store,
        repository: input.repository,
        operationId: input.planId,
        ledgerKind: kind,
        entries: input.entries[kind],
        nowIso: input.nowIso,
        idFactory: input.idFactory,
      }),
    ),
  );
}

function rootsFrom(
  root: (kind: ImportLedgerKind) => {
    pageCount: number;
    entryCount: number;
    rootHash: string;
  },
): ImportPlanLedgerRoots {
  const values = Object.fromEntries(
    ledgerKinds.map((kind) => [kind, root(kind)]),
  ) as Record<ImportLedgerKind, ReturnType<typeof root>>;
  return {
    importIdMap: values.import_id_map,
    importConflicts: values.import_conflicts,
    importWrites: values.import_writes,
    importReleases: values.import_releases,
    importRebases: values.import_rebases,
    preparedMedia: values.prepared_media,
    importAuthorizations: values.import_authorizations,
  };
}

function assertRootsEqual(
  actual: ImportPlanLedgerRoots,
  expected: ImportPlanLedgerRoots,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new Error("IMPORT_PLAN_LEDGER_ROOT_MISMATCH");
}

function assertRevision(
  target: ImportPlanTargetReader,
  collection: string,
  id: string,
  expected: string,
): void {
  if (target.revisionHash(collection, id) !== expected)
    throw new Error("IMPORT_PLAN_TARGET_REVISION_MISMATCH");
}

function collectionForNamespace(namespace: string): string {
  if (namespace === "asset" || namespace === "assets") return "assets";
  if (namespace === "original" || namespace === "original_assets")
    return "original_assets";
  return namespace;
}

function requiredMappedId(
  idMap: ReadonlyMap<string, string>,
  namespace: string,
  sourceId: string,
): string {
  const target = lookupExactId(idMap, namespace, sourceId);
  if (!target) throw new Error("IMPORT_PLAN_REQUIRED_MAPPING_MISSING");
  return target;
}

function requiredHash(value: string | null): string {
  if (!value) throw new Error("IMPORT_PLAN_SOURCE_FACT_MISSING");
  return value;
}

function field(
  document: Readonly<Record<string, unknown>> | null,
  name: string,
): unknown {
  return document?.[name];
}

function projectMode(mode: ImportPlanRequest["mode"]): boolean {
  return mode === "as_new_project" || mode === "replace_existing";
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
