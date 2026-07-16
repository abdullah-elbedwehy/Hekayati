import { createHash } from "node:crypto";

import { canonicalJson } from "../../contracts/canonical-json.js";
import { createExactIdMap } from "./id-map.js";
import { compileImportPlan } from "./import-plan-compile.js";
import type { ImportPlan } from "./import-plan-model.js";
import { selectImportBundle, type ImportPlanSourceBundle } from "./import-plan-selection.js";
import type { ImportPlanTargetReader } from "./import-plan-target.js";
import type {
  ImportAuthorizationLedgerEntry,
  ImportConflictLedgerEntry,
  ImportMappingLedgerEntry,
  ImportRebaseLedgerEntry,
  ImportWriteLedgerEntry,
  PreparedMediaIntentLedgerEntry,
} from "./import-ledger.js";
import type { PortabilityRegistry } from "./participants.js";
import type { PortabilityLedgerRepository } from "./repositories.js";
import type {
  PortabilityLedgerEntry,
  PortabilityLedgerKind,
} from "./schemas.js";

export function recompileStoredImportPlan(input: {
  plan: ImportPlan;
  source: ImportPlanSourceBundle;
  ledgers: PortabilityLedgerRepository;
  registry: PortabilityRegistry;
  target: ImportPlanTargetReader;
}) {
  const entries = readPlanEntries(input.plan, input.ledgers);
  const mappings = selectEntries(entries.importIdMap, "import_mapping");
  const conflicts = selectEntries(entries.importConflicts, "import_conflict");
  const request = requestFromPlan(input.plan, mappings, entries.importWrites);
  const allocation = {
    idMap: createExactIdMap(mappings),
    mappings,
    conflicts,
  };
  assertImportPlanTargetEvidence(input.plan, mappings, input.target);
  const selected = selectImportBundle({
    request,
    source: input.source,
    registry: input.registry,
  });
  const compiled = compileImportPlan({
    request,
    source: input.source,
    selected,
    allocation,
    registry: input.registry,
    target: input.target,
  });
  assertCompiledEntries(compiled, entries);
  return Object.freeze({
    request,
    allocation,
    selected,
    compiled,
    graphHash: hash(
      compiled.documents.map((item) => ({
        collection: item.collection,
        targetId: item.targetId,
        document: item.document,
      })),
    ),
  });
}

export function assertImportPlanTargetEvidence(
  plan: ImportPlan,
  mappings: readonly ImportMappingLedgerEntry[],
  target: ImportPlanTargetReader,
): void {
  for (const mapping of mappings) {
    if (
      mapping.targetRevisionHash !== null &&
      target.revisionHash(
        collectionForNamespace(mapping.namespace),
        mapping.targetId,
      ) !== mapping.targetRevisionHash
    )
      throw new Error("IMPORT_COMMIT_TARGET_REVISION_MISMATCH");
  }
  if (
    plan.target.templateCatalogRevisionHash !== null &&
    target.templateCatalogRevisionHash() !==
      plan.target.templateCatalogRevisionHash
  )
    throw new Error("IMPORT_COMMIT_TEMPLATE_CATALOG_STALE");
  if (plan.mode !== "replace_existing") return;
  const project = requiredTarget(
    target,
    "projects",
    requiredId(plan.target.projectId),
  );
  if (
    field(project, "revision") !== plan.target.projectRevision ||
    field(project, "customerId") !== plan.target.customerId ||
    field(project, "familyId") !== plan.target.familyId ||
    target.revisionHash("projects", project.id) !==
      plan.target.projectRevisionHash
  )
    throw new Error("IMPORT_COMMIT_REPLACE_TARGET_MISMATCH");
}

interface PlanEntries {
  importIdMap: PortabilityLedgerEntry[];
  importConflicts: PortabilityLedgerEntry[];
  importWrites: PortabilityLedgerEntry[];
  importReleases: PortabilityLedgerEntry[];
  importRebases: PortabilityLedgerEntry[];
  preparedMedia: PortabilityLedgerEntry[];
  importAuthorizations: PortabilityLedgerEntry[];
}

function readPlanEntries(
  plan: ImportPlan,
  ledgers: PortabilityLedgerRepository,
): PlanEntries {
  return {
    importIdMap: readLedger(
      ledgers,
      plan.id,
      "import_id_map",
      plan.ledgerRoots.importIdMap,
    ),
    importConflicts: readLedger(
      ledgers,
      plan.id,
      "import_conflicts",
      plan.ledgerRoots.importConflicts,
    ),
    importWrites: readLedger(
      ledgers,
      plan.id,
      "import_writes",
      plan.ledgerRoots.importWrites,
    ),
    importReleases: readLedger(
      ledgers,
      plan.id,
      "import_releases",
      plan.ledgerRoots.importReleases,
    ),
    importRebases: readLedger(
      ledgers,
      plan.id,
      "import_rebases",
      plan.ledgerRoots.importRebases,
    ),
    preparedMedia: readLedger(
      ledgers,
      plan.id,
      "prepared_media",
      plan.ledgerRoots.preparedMedia,
    ),
    importAuthorizations: readLedger(
      ledgers,
      plan.id,
      "import_authorizations",
      plan.ledgerRoots.importAuthorizations,
    ),
  };
}

function readLedger(
  ledgers: PortabilityLedgerRepository,
  planId: string,
  kind: PortabilityLedgerKind,
  expected: { pageCount: number; entryCount: number; rootHash: string },
): PortabilityLedgerEntry[] {
  const root = ledgers.root(planId, kind);
  if (
    root.pageCount !== expected.pageCount ||
    root.entryCount !== expected.entryCount ||
    root.rootHash !== expected.rootHash
  )
    throw new Error("IMPORT_COMMIT_PLAN_LEDGER_MISMATCH");
  return ledgers.pages(planId, kind).flatMap((page) => page.entries);
}

function requestFromPlan(
  plan: ImportPlan,
  mappings: readonly ImportMappingLedgerEntry[],
  writes: readonly PortabilityLedgerEntry[],
) {
  return {
    idempotencyKey: "stored-plan-recompile",
    expectedOperationRevision: plan.operationRevision,
    mode: plan.mode,
    sourceRoot: {
      projectId: plan.source.projectId,
      customerId: plan.source.customerId,
      familyId: plan.source.familyId,
    },
    customerResolution: customerResolution(plan),
    replaceTarget:
      plan.mode === "replace_existing"
        ? {
            projectId: requiredId(plan.target.projectId),
            projectRevision: requiredNumber(plan.target.projectRevision),
            projectRevisionHash: requiredHash(
              plan.target.projectRevisionHash,
            ),
            destructiveScopeConfirmed: true,
          }
        : null,
    selectedCharacterIds:
      plan.mode === "characters_only"
        ? sourceIds(mappings, "characters")
        : [],
    selectedTemplateIds:
      plan.mode === "templates_only"
        ? sourceIds(mappings, "story_templates")
        : [],
    templateCatalogRevisionHash: plan.target.templateCatalogRevisionHash,
    explicitMappings: [],
    approvalPolicy:
      plan.counts.approvalsPreserved > 0
        ? ("preserve_if_proven" as const)
        : ("demote" as const),
  };
}

function customerResolution(plan: ImportPlan) {
  if (plan.customerResolution.kind === "not_applicable") return null;
  if (plan.customerResolution.kind === "create_from_archive")
    return { kind: "create_from_archive" as const };
  return {
    kind: "map_existing_same_customer" as const,
    targetCustomerId: requiredId(plan.target.customerId),
    targetFamilyId: requiredId(plan.target.familyId),
    targetCustomerRevisionHash: requiredHash(plan.target.customerRevisionHash),
    targetFamilyRevisionHash: requiredHash(plan.target.familyRevisionHash),
    sameRealCustomerAttested: true,
  };
}

function assertCompiledEntries(
  compiled: ReturnType<typeof compileImportPlan>,
  entries: PlanEntries,
): void {
  const comparisons = [
    [compiled.writes, selectEntries(entries.importWrites, "import_write")],
    [compiled.rebases, selectEntries(entries.importRebases, "import_rebase")],
    [compiled.releases, entries.importReleases],
    [
      compiled.preparedMedia,
      selectEntries(entries.preparedMedia, "prepared_media_intent"),
    ],
    [
      compiled.authorizations,
      selectEntries(entries.importAuthorizations, "import_authorization"),
    ],
  ] as const;
  if (
    comparisons.some(
      ([actual, expected]) => canonicalJson(actual) !== canonicalJson(expected),
    )
  )
    throw new Error("IMPORT_COMMIT_PLAN_RECOMPILE_MISMATCH");
}

type EntryByType = {
  import_mapping: ImportMappingLedgerEntry;
  import_conflict: ImportConflictLedgerEntry;
  import_write: ImportWriteLedgerEntry;
  import_rebase: ImportRebaseLedgerEntry;
  prepared_media_intent: PreparedMediaIntentLedgerEntry;
  import_authorization: ImportAuthorizationLedgerEntry;
};

function selectEntries<Type extends keyof EntryByType>(
  entries: readonly PortabilityLedgerEntry[],
  type: Type,
): EntryByType[Type][] {
  const selected = entries.filter(
    (entry): entry is EntryByType[Type] => entry.entryType === type,
  );
  if (selected.length !== entries.length)
    throw new Error("IMPORT_COMMIT_PLAN_LEDGER_KIND_INVALID");
  return selected;
}

function sourceIds(
  mappings: readonly ImportMappingLedgerEntry[],
  namespace: string,
): string[] {
  return mappings
    .filter((mapping) => mapping.namespace === namespace)
    .map((mapping) => mapping.sourceId)
    .sort();
}

function collectionForNamespace(namespace: string): string {
  if (namespace === "asset") return "assets";
  if (namespace === "original") return "original_assets";
  return namespace;
}

function requiredTarget(
  target: ImportPlanTargetReader,
  collection: string,
  id: string,
) {
  const document = target.document(collection, id);
  if (!document) throw new Error("IMPORT_COMMIT_TARGET_MISSING");
  return document;
}

function field(document: Readonly<Record<string, unknown>>, name: string) {
  return document[name];
}

function requiredId(value: string | null): string {
  if (!value) throw new Error("IMPORT_COMMIT_PLAN_TARGET_MISSING");
  return value;
}

function requiredHash(value: string | null): string {
  if (!value) throw new Error("IMPORT_COMMIT_PLAN_HASH_MISSING");
  return value;
}

function requiredNumber(value: number | null): number {
  if (value === null) throw new Error("IMPORT_COMMIT_PLAN_REVISION_MISSING");
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
