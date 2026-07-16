import type { BaseDocument } from "../repository/document-store.js";
import {
  createExactIdMap,
  entityNamespace,
  exactIdMappings,
  lookupExactId,
  type ExactIdMapping,
} from "./id-map.js";
import {
  explicitImportIdValues,
  importIdentityAlias,
} from "./import-id-rules.js";
import type {
  ImportConflictLedgerEntry,
  ImportMappingLedgerEntry,
} from "./import-ledger.js";
import type { ImportPlanRequest } from "./import-plan-model.js";
import type {
  ImportPlanSourceBundle,
  SelectedImportBundle,
} from "./import-plan-selection.js";
import type { ImportPlanTargetReader } from "./import-plan-target.js";
import type { ExactIdMap, PortabilityRegistry } from "./participants.js";

export interface ImportIdAllocation {
  readonly idMap: ExactIdMap;
  readonly mappings: readonly ImportMappingLedgerEntry[];
  readonly conflicts: readonly ImportConflictLedgerEntry[];
}

interface MutableAllocation {
  readonly entries: Map<string, ImportMappingLedgerEntry>;
  readonly usedTargets: Set<string>;
}

export function allocateImportIds(input: {
  readonly request: ImportPlanRequest;
  readonly source: ImportPlanSourceBundle;
  readonly selected: SelectedImportBundle;
  readonly registry: PortabilityRegistry;
  readonly target: ImportPlanTargetReader;
  readonly idFactory: () => string;
}): ImportIdAllocation {
  const allocation: MutableAllocation = {
    entries: new Map(),
    usedTargets: new Set(),
  };
  addExplicitMappings(input, allocation);
  addCustomerResolution(input, allocation);
  addReplaceTarget(input, allocation);
  addExactMediaMappings(input, allocation);
  addDocumentMappings(input, allocation, false);
  addDocumentMappings(input, allocation, true);
  addDeclaredReferenceMappings(input, allocation);
  addExplicitAuxiliaryMappings(input, allocation);
  const mappings = [...allocation.entries.values()].sort(compareMappings);
  const idMap = createExactIdMap(mappings);
  assertUnambiguousExplicitRules(input.selected, idMap);
  return Object.freeze({
    idMap,
    mappings: Object.freeze(mappings),
    conflicts: Object.freeze(mappings.map(conflictForMapping)),
  });
}

function addExplicitMappings(
  input: Parameters<typeof allocateImportIds>[0],
  allocation: MutableAllocation,
): void {
  for (const mapping of input.request.explicitMappings) {
    addMapping(allocation, {
      entryType: "import_mapping",
      namespace: normalizedNamespace(mapping.namespace),
      sourceId: mapping.sourceId,
      targetId: mapping.targetId,
      disposition: "mapped_existing",
      targetRevisionHash: mapping.targetRevisionHash,
    });
  }
}

function addCustomerResolution(
  input: Parameters<typeof allocateImportIds>[0],
  allocation: MutableAllocation,
): void {
  const resolution = input.request.customerResolution;
  if (!resolution) return;
  if (resolution.kind === "map_existing_same_customer") {
    addExisting(
      allocation,
      "customers",
      input.source.root.customerId,
      resolution.targetCustomerId,
      resolution.targetCustomerRevisionHash,
    );
    addExisting(
      allocation,
      "families",
      input.source.root.familyId,
      resolution.targetFamilyId,
      resolution.targetFamilyRevisionHash,
    );
    return;
  }
  addFresh(input, allocation, "customers", input.source.root.customerId);
  addFresh(input, allocation, "families", input.source.root.familyId);
}

function addReplaceTarget(
  input: Parameters<typeof allocateImportIds>[0],
  allocation: MutableAllocation,
): void {
  const target = input.request.replaceTarget;
  if (!target) return;
  addExisting(
    allocation,
    "projects",
    input.source.root.projectId,
    target.projectId,
    target.projectRevisionHash,
  );
}

function addExactMediaMappings(
  input: Parameters<typeof allocateImportIds>[0],
  allocation: MutableAllocation,
): void {
  const documents = documentIndex(input.selected.documents);
  for (const facts of input.selected.media) {
    const collection =
      facts.namespace === "asset" ? "assets" : "original_assets";
    const source = documents.get(`${collection}:${facts.id}`)?.document ?? null;
    const exact = input.target.findExactMedia(facts, source);
    if (exact) {
      addMapping(allocation, {
        entryType: "import_mapping",
        namespace: facts.namespace,
        sourceId: facts.id,
        targetId: exact.id,
        disposition: "deduplicated",
        targetRevisionHash: exact.revisionHash,
      });
    } else addFresh(input, allocation, facts.namespace, facts.id);
  }
}

function addDocumentMappings(
  input: Parameters<typeof allocateImportIds>[0],
  allocation: MutableAllocation,
  aliases: boolean,
): void {
  const ordered = [...input.selected.documents].sort(
    (left, right) =>
      left.collection.localeCompare(right.collection) ||
      left.id.localeCompare(right.id),
  );
  for (const item of ordered) {
    const alias = importIdentityAlias(item.collection);
    if (Boolean(alias) !== aliases) continue;
    const namespace = entityNamespace(item.collection);
    if (hasMapping(allocation, namespace, item.id)) continue;
    if (!alias) {
      addFresh(input, allocation, namespace, item.id);
      continue;
    }
    const sourceTarget = stringAt(item.document, alias.targetPath);
    const targetId = targetForSource(
      allocation,
      alias.targetCollection,
      sourceTarget,
    );
    if (!targetId) throw new Error("IMPORT_PLAN_IDENTITY_ALIAS_TARGET_MISSING");
    addMapping(allocation, {
      entryType: "import_mapping",
      namespace,
      sourceId: item.id,
      targetId,
      disposition: "alias",
      targetRevisionHash: null,
    });
  }
}

function addDeclaredReferenceMappings(
  input: Parameters<typeof allocateImportIds>[0],
  allocation: MutableAllocation,
): void {
  const selected = new Set(
    input.selected.documents.map((item) => `${item.collection}:${item.id}`),
  );
  for (const item of input.selected.documents) {
    const participant = input.registry.forCollection(item.collection);
    const refs = [
      ...participant.ownerReferences(item.document),
      ...participant.references(item.document),
    ];
    for (const reference of refs) {
      const namespace = entityNamespace(reference.collection);
      if (hasMapping(allocation, namespace, reference.id)) continue;
      if (hasAnySourceMapping(allocation, reference.id)) continue;
      if (
        reference.required !== false ||
        selected.has(`${reference.collection}:${reference.id}`)
      )
        throw new Error("IMPORT_PLAN_REQUIRED_REFERENCE_NOT_SELECTED");
      addFresh(input, allocation, namespace, reference.id);
    }
  }
}

function addExplicitAuxiliaryMappings(
  input: Parameters<typeof allocateImportIds>[0],
  allocation: MutableAllocation,
): void {
  for (const item of input.selected.documents) {
    for (const value of explicitImportIdValues(
      item.collection,
      item.document,
    )) {
      if (value.namespace) {
        if (!hasMapping(allocation, value.namespace, value.sourceId))
          addFresh(input, allocation, value.namespace, value.sourceId);
        continue;
      }
      if (!hasAnySourceMapping(allocation, value.sourceId))
        addFresh(input, allocation, "import_auxiliary", value.sourceId);
    }
  }
}

function addFresh(
  input: Parameters<typeof allocateImportIds>[0],
  allocation: MutableAllocation,
  namespace: string,
  sourceId: string,
): void {
  const normalized = normalizedNamespace(namespace);
  if (hasMapping(allocation, normalized, sourceId)) return;
  addMapping(allocation, {
    entryType: "import_mapping",
    namespace: normalized,
    sourceId,
    targetId: nextAvailableId(input, allocation, normalized),
    disposition: "fresh",
    targetRevisionHash: null,
  });
}

function addExisting(
  allocation: MutableAllocation,
  namespace: string,
  sourceId: string,
  targetId: string,
  targetRevisionHash: string,
): void {
  addMapping(allocation, {
    entryType: "import_mapping",
    namespace,
    sourceId,
    targetId,
    disposition: "mapped_existing",
    targetRevisionHash,
  });
}

function addMapping(
  allocation: MutableAllocation,
  mapping: ImportMappingLedgerEntry,
): void {
  const key = mappingKey(mapping.namespace, mapping.sourceId);
  const existing = allocation.entries.get(key);
  if (existing) {
    if (existing.targetId !== mapping.targetId)
      throw new Error("IMPORT_PLAN_MAPPING_CONFLICT");
    return;
  }
  allocation.entries.set(key, mapping);
  allocation.usedTargets.add(mappingKey(mapping.namespace, mapping.targetId));
}

function nextAvailableId(
  input: Parameters<typeof allocateImportIds>[0],
  allocation: MutableAllocation,
  namespace: string,
): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const id = input.idFactory();
    const key = mappingKey(namespace, id);
    if (
      !allocation.usedTargets.has(key) &&
      !input.target.idExists(namespace, id)
    )
      return id;
  }
  throw new Error("IMPORT_PLAN_ID_ALLOCATION_EXHAUSTED");
}

function assertUnambiguousExplicitRules(
  selected: SelectedImportBundle,
  idMap: ExactIdMap,
): void {
  for (const item of selected.documents) {
    for (const value of explicitImportIdValues(item.collection, item.document))
      lookupExactId(idMap, value.namespace, value.sourceId);
  }
}

function conflictForMapping(
  mapping: ImportMappingLedgerEntry,
): ImportConflictLedgerEntry {
  const details = {
    fresh: ["ARCHIVE_ID_REMAP", "fresh_id"],
    mapped_existing: ["EXACT_TARGET_MAPPING", "map_existing"],
    deduplicated: ["EXACT_MEDIA_MATCH", "deduplicate_exact_media"],
    alias: ["IDENTITY_ALIAS", "map_existing"],
  } as const;
  const [conflictKind, resolution] = details[mapping.disposition];
  return {
    entryType: "import_conflict",
    conflictKind,
    namespace: mapping.namespace,
    sourceId: mapping.sourceId,
    targetId: mapping.targetId,
    resolution,
    targetRevisionHash: mapping.targetRevisionHash,
  };
}

function targetForSource(
  allocation: MutableAllocation,
  namespace: string,
  sourceId: string,
): string | null {
  return (
    allocation.entries.get(mappingKey(entityNamespace(namespace), sourceId))
      ?.targetId ?? null
  );
}

function hasMapping(
  allocation: MutableAllocation,
  namespace: string,
  sourceId: string,
): boolean {
  return allocation.entries.has(
    mappingKey(normalizedNamespace(namespace), sourceId),
  );
}

function hasAnySourceMapping(
  allocation: MutableAllocation,
  sourceId: string,
): boolean {
  return [...allocation.entries.values()].some(
    (mapping) => mapping.sourceId === sourceId,
  );
}

function mappingKey(namespace: string, id: string): string {
  return `${normalizedNamespace(namespace)}\0${id}`;
}

function normalizedNamespace(namespace: string): string {
  if (namespace === "assets") return "asset";
  if (namespace === "original_assets") return "original";
  return namespace;
}

function compareMappings(
  left: ImportMappingLedgerEntry,
  right: ImportMappingLedgerEntry,
): number {
  return (
    left.namespace.localeCompare(right.namespace) ||
    left.sourceId.localeCompare(right.sourceId)
  );
}

function documentIndex(
  documents: SelectedImportBundle["documents"],
): ReadonlyMap<string, { document: Readonly<BaseDocument> }> {
  return new Map(
    documents.map((item) => [
      `${item.collection}:${item.id}`,
      { document: item.document },
    ]),
  );
}

function stringAt(document: Readonly<BaseDocument>, path: string): string {
  let current: unknown = document;
  for (const segment of path.split("."))
    current = (current as Readonly<Record<string, unknown>>)[segment];
  if (typeof current !== "string")
    throw new Error("IMPORT_PLAN_IDENTITY_ALIAS_SOURCE_INVALID");
  return current;
}

export function allocationExactMappings(
  allocation: ImportIdAllocation,
): readonly ExactIdMapping[] {
  return exactIdMappings(allocation.idMap);
}
