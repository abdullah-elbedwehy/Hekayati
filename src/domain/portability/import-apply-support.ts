import { createHash } from "node:crypto";

import { canonicalJson } from "../../contracts/canonical-json.js";
import type { LoadedValidatedImportSource } from "../../portability/import-staging-reader.js";
import type { ImportApplyMediaInput } from "./import-apply-media.js";
import type {
  ImportCommitProgress,
  ImportCommitRequest,
  ImportCommitResult,
} from "./import-apply-model.js";
import type { ImportOperation } from "./import-model.js";
import type { ImportPlan } from "./import-plan-model.js";
import { recompileStoredImportPlan } from "./import-plan-replay.js";
import type { ImportPlanTargetReader } from "./import-plan-target.js";
import {
  portabilityActionRequestHash,
  type PortabilityActionBoundaryInput,
} from "./operation-ledgers.js";
import type { ImportOperationRepository } from "./import-storage.js";
import type {
  PortabilityAction,
  PortabilityScope,
  PortabilityScopeLock,
} from "./schemas.js";

export type RecompiledImportPlan = ReturnType<
  typeof recompileStoredImportPlan
>;

export function commitBoundaryInput(
  operation: ImportOperation,
  plan: ImportPlan,
  request: ImportCommitRequest,
): PortabilityActionBoundaryInput {
  const input = {
    operationScope: { kind: "import_operation" as const, id: operation.id },
    action:
      plan.mode === "replace_existing"
        ? ("replace_commit" as const)
        : ("import_commit" as const),
    idempotencyKey: request.idempotencyKey,
    input: {
      revisions: { operation: request.expectedOperationRevision },
      hashes: {
        plan: hash(plan),
        confirmation: request.confirmationHash,
        archive: operation.sourceArchiveHash,
        snapshot: requiredHash(operation.sourceSnapshotHash),
        registry: requiredHash(operation.participantRegistryHash),
        request: hash(request),
      },
      counts: {
        writes: plan.counts.writes,
        preparedMedia: plan.counts.preparedMedia,
        releases: plan.counts.releases,
      },
      flags: {
        finalConfirmation: request.finalConfirmation,
        replaceExisting: plan.mode === "replace_existing",
      },
    },
  };
  return { ...input, requestHash: portabilityActionRequestHash(input) };
}

export function applyMediaInput(
  operationId: string,
  planId: string,
  prepared: {
    loaded: LoadedValidatedImportSource;
    replay: RecompiledImportPlan;
  },
): ImportApplyMediaInput {
  return {
    operationId,
    planId,
    source: prepared.loaded.source,
    compiled: prepared.replay.compiled,
    readMedia: prepared.loaded.readMedia,
  };
}

export function importScope(plan: ImportPlan): PortabilityScope {
  if (plan.mode === "templates_only")
    return { kind: "template_catalog", id: "template_catalog" };
  if (plan.mode === "characters_only") {
    const customerId = requiredId(plan.target.customerId);
    return { kind: "customer", id: customerId, customerId };
  }
  const projectId = requiredId(plan.target.projectId);
  const customerId = requiredId(plan.target.customerId);
  return { kind: "project", id: projectId, projectId, customerId };
}

export function commitLock(
  lock: PortabilityScopeLock,
): ImportCommitProgress["lock"] {
  if (
    (lock.mode !== "import_commit" && lock.mode !== "replace_import") ||
    lock.phase === "snapshot"
  )
    throw new Error("IMPORT_COMMIT_LOCK_MODE_INVALID");
  return {
    id: lock.id,
    mode: lock.mode,
    phase: lock.phase,
    revision: lock.revision,
    scope: lock.scope,
  };
}

export function assertMatchingProgress(
  operation: ImportOperation,
  plan: ImportPlan,
  request: ImportCommitRequest,
  requestHash: string,
): void {
  const commit = requiredCommit(operation);
  if (
    operation.planId !== plan.id ||
    commit.idempotencyKey !== request.idempotencyKey ||
    commit.requestHash !== requestHash ||
    commit.expectedOperationRevision !== request.expectedOperationRevision ||
    commit.planConfirmationHash !== request.confirmationHash ||
    commit.action !==
      (plan.mode === "replace_existing" ? "replace_commit" : "import_commit")
  )
    throw new Error("IMPORT_COMMIT_IN_PROGRESS_CONFLICT");
}

export function assertPreparing(
  operation: ImportOperation,
  plan: ImportPlan,
): void {
  if (
    operation.state !== "committing" ||
    operation.planId !== plan.id ||
    operation.commit?.phase !== "preparing" ||
    operation.commit.result !== null
  )
    throw new Error("IMPORT_COMMIT_STATE_INVALID");
}

export function assertPlanSource(
  operation: ImportOperation,
  plan: ImportPlan,
  loaded: LoadedValidatedImportSource,
  registryHash: string,
): void {
  if (
    plan.source.archiveHash !== operation.sourceArchiveHash ||
    plan.source.normalizedManifestHash !== operation.normalizedManifestHash ||
    plan.source.snapshotHash !== loaded.source.sourceSnapshotHash ||
    plan.source.graphHash !== loaded.source.graphHash ||
    plan.source.participantRegistryHash !== registryHash ||
    loaded.source.root.projectId !== plan.source.projectId ||
    loaded.source.root.customerId !== plan.source.customerId ||
    loaded.source.root.familyId !== plan.source.familyId
  )
    throw new Error("IMPORT_COMMIT_SOURCE_FACT_MISMATCH");
}

export function assertWriteTargets(
  plan: ImportPlan,
  replay: RecompiledImportPlan,
  target: ImportPlanTargetReader,
): void {
  for (const item of replay.compiled.documents) {
    const current = target.document(item.collection, item.targetId);
    if (item.disposition === "create" && current)
      throw new Error("IMPORT_COMMIT_TARGET_ID_CONFLICT");
    if (
      item.disposition === "replace" &&
      (plan.mode !== "replace_existing" ||
        item.collection !== "projects" ||
        item.targetId !== plan.target.projectId ||
        !current)
    )
      throw new Error("IMPORT_COMMIT_REPLACE_WRITE_INVALID");
  }
}

export function assertCommittedGraph(
  replay: RecompiledImportPlan,
  target: ImportPlanTargetReader,
): void {
  for (const item of replay.compiled.documents)
    if (
      canonicalJson(target.document(item.collection, item.targetId)) !==
      canonicalJson(item.document)
    )
      throw new Error("IMPORT_COMMIT_GRAPH_VERIFICATION_FAILED");
}

export function currentTargetSnapshotHash(
  plan: ImportPlan,
  replay: RecompiledImportPlan,
  target: ImportPlanTargetReader,
): string {
  return hash({
    contract: "HekayatiImportTargetSnapshot/v1",
    mode: plan.mode,
    target: plan.target,
    mappings: replay.allocation.mappings.map((mapping) => ({
      namespace: mapping.namespace,
      targetId: mapping.targetId,
      revisionHash: target.revisionHash(
        collectionForNamespace(mapping.namespace),
        mapping.targetId,
      ),
    })),
    writes: replay.compiled.documents.map((item) => ({
      collection: item.collection,
      targetId: item.targetId,
      disposition: item.disposition,
      revisionHash: target.revisionHash(item.collection, item.targetId),
    })),
    templateCatalog:
      plan.mode === "templates_only"
        ? target.templateCatalogRevisionHash()
        : null,
  });
}

export function commitActionResult(
  plan: ImportPlan,
  result: ImportCommitResult,
) {
  return {
    kind: "inline" as const,
    state: "imported",
    entityIds: targetRootIds(plan),
    counts: {
      documents: result.documentCount,
      preparedMedia: result.preparedMediaCount,
      canceledJobs: result.canceledJobCount,
    },
    hashes: {
      graph: result.graphHash,
      cleanup: result.cleanupLedgerRoot,
    },
    flags: { replaceExisting: plan.mode === "replace_existing" },
  };
}

export function assertCommitActionMatches(
  action: PortabilityAction,
  result: ImportCommitResult,
): void {
  if (
    action.result.kind !== "inline" ||
    action.result.state !== "imported" ||
    action.result.hashes.graph !== result.graphHash ||
    action.result.hashes.cleanup !== result.cleanupLedgerRoot ||
    action.result.counts.documents !== result.documentCount ||
    action.result.counts.preparedMedia !== result.preparedMediaCount ||
    action.result.counts.canceledJobs !== result.canceledJobCount
  )
    throw new Error("IMPORT_COMMIT_ACTION_RESULT_INVALID");
}

export function requestFromProgress(
  operation: ImportOperation,
): ImportCommitRequest {
  const commit = requiredCommit(operation);
  return {
    idempotencyKey: commit.idempotencyKey,
    expectedOperationRevision: commit.expectedOperationRevision,
    planId: requiredId(operation.planId),
    confirmationHash: commit.planConfirmationHash,
    finalConfirmation: true,
  };
}

export function assertProofPinned(
  operationId: string,
  sourceProofHash: string,
  operations: ImportOperationRepository,
): void {
  if (operations.get(operationId)?.commit?.sourceProofHash !== sourceProofHash)
    throw new Error("IMPORT_COMMIT_SOURCE_PROOF_MISMATCH");
}

export function requiredCommit(operation: ImportOperation) {
  if (!operation.commit) throw new Error("IMPORT_COMMIT_BINDING_MISSING");
  return operation.commit;
}

export function requiredId(value: string | null): string {
  if (!value) throw new Error("IMPORT_COMMIT_ID_MISSING");
  return value;
}

export function requiredHash(value: string | null | undefined): string {
  if (!value) throw new Error("IMPORT_COMMIT_HASH_MISSING");
  return value;
}

export function boundedFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.message))
    return error.message;
  return "IMPORT_COMMIT_FAILED";
}

export function targetRootIds(plan: ImportPlan): string[] {
  if (plan.target.projectId) return [plan.target.projectId];
  if (plan.target.customerId) return [plan.target.customerId];
  return [];
}

function collectionForNamespace(namespace: string): string {
  if (namespace === "asset") return "assets";
  if (namespace === "original") return "original_assets";
  return namespace;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
