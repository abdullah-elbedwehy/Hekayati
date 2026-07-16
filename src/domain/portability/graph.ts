import { createHash } from "node:crypto";

import { canonicalJson } from "../../contracts/canonical-json.js";
import type { BaseDocument } from "../repository/document-store.js";
import type {
  PortabilityDocumentReference,
  PortabilityMediaReference,
  PortabilityParticipant,
  PortabilityRegistry,
  PortabilityRoot,
} from "./participants.js";

export interface PortabilityStoredDocument {
  collection: string;
  document: unknown;
}

export interface SelectedPortabilityDocument {
  collection: string;
  id: string;
  document: BaseDocument;
  reasons: readonly string[];
}

export interface SelectedPortabilityMediaReference {
  namespace: "asset" | "original";
  id: string;
  ownership: PortabilityMediaReference["ownership"];
  sourceCollection: string;
  sourceId: string;
  field: string;
}

export interface SelectedPortabilityMedia {
  namespace: "asset" | "original";
  id: string;
  occurrenceCount: number;
  ownedCount: number;
  referencedCount: number;
  outsideScopeOccurrenceCount: number;
}

export interface PortabilityGraphSelection {
  root: PortabilityRoot;
  documents: readonly SelectedPortabilityDocument[];
  mediaReferences: readonly SelectedPortabilityMediaReference[];
  media: readonly SelectedPortabilityMedia[];
  hash: string;
}

interface IndexedDocument {
  key: string;
  collection: string;
  document: BaseDocument;
  participant: PortabilityParticipant;
}

export function selectPortabilityGraph(input: {
  registry: PortabilityRegistry;
  documents: readonly PortabilityStoredDocument[];
  root: PortabilityRoot;
}): PortabilityGraphSelection {
  const { indexed, allMediaReferences } = indexDocuments(
    input.registry,
    input.documents,
    input.root,
  );
  const selected = new Map<string, Set<string>>();
  selectDirect(indexed, input.root, selected);
  closeGraph(indexed, selected, input.root);
  assertSingleRoot(indexed, selected, input.root);

  const documents = selectedDocuments(indexed, selected);
  const mediaReferences = collectMediaReferences(indexed, selected);
  const media = uniqueMedia(mediaReferences, allMediaReferences);
  const identity = {
    root: input.root,
    registryHash: input.registry.hash,
    documents,
    mediaReferences,
    media,
  };
  return Object.freeze({
    root: Object.freeze({ ...input.root }),
    documents,
    mediaReferences,
    media,
    hash: sha256(canonicalJson(identity)),
  });
}

function indexDocuments(
  registry: PortabilityRegistry,
  stored: readonly PortabilityStoredDocument[],
  root: PortabilityRoot,
): {
  indexed: ReadonlyMap<string, IndexedDocument>;
  allMediaReferences: readonly SelectedPortabilityMediaReference[];
} {
  const catalog = new Map(
    registry.catalog.collections.map((entry) => [entry.key, entry.owner]),
  );
  const indexed = new Map<string, IndexedDocument>();
  const allMediaReferences: SelectedPortabilityMediaReference[] = [];
  for (const item of stored) {
    const owner = catalog.get(item.collection);
    if (!owner)
      throw new Error(`PORTABILITY_COLLECTION_UNREGISTERED:${item.collection}`);
    if (owner !== "participant") continue;
    const participant = registry.forCollection(item.collection);
    if (!supportsRoot(participant, root)) continue;
    const document = participant.schema.parse(item.document);
    const candidate = {
      key: documentKey(item.collection, document.id),
      collection: item.collection,
      document,
      participant,
    };
    appendParticipantMedia(allMediaReferences, candidate);
    const key = documentKey(item.collection, document.id);
    if (indexed.has(key)) throw new Error("PORTABILITY_DOCUMENT_DUPLICATE");
    indexed.set(key, {
      key,
      collection: item.collection,
      document,
      participant,
    });
  }
  return {
    indexed,
    allMediaReferences: Object.freeze(allMediaReferences),
  };
}

function selectDirect(
  indexed: ReadonlyMap<string, IndexedDocument>,
  root: PortabilityRoot,
  selected: Map<string, Set<string>>,
): void {
  for (const item of indexed.values()) {
    if (!supportsRoot(item.participant, root)) continue;
    const reason =
      root.kind === "project"
        ? item.participant.selectForProject(item.document, root)
        : item.participant.selectForCustomer(item.document, root);
    if (reason !== null) {
      select(selected, item.key, reason);
    }
  }
}

function closeGraph(
  indexed: ReadonlyMap<string, IndexedDocument>,
  selected: Map<string, Set<string>>,
  root: PortabilityRoot,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...selected.keys()]) {
      const item = indexed.get(key)!;
      const refs = [
        ...item.participant.ownerReferences(item.document),
        ...item.participant.references(item.document),
      ];
      for (const reference of refs)
        changed =
          selectReference(indexed, selected, item, reference) || changed;
      for (const mediaRef of item.participant.assetReferences(item.document))
        changed =
          selectMedia(indexed, selected, item, "asset", mediaRef) || changed;
      for (const mediaRef of item.participant.originalReferences(item.document))
        changed =
          selectMedia(indexed, selected, item, "original", mediaRef) || changed;
    }
    changed = selectOwnedChildren(indexed, selected, root) || changed;
  }
}

function selectReference(
  indexed: ReadonlyMap<string, IndexedDocument>,
  selected: Map<string, Set<string>>,
  source: IndexedDocument,
  reference: PortabilityDocumentReference,
): boolean {
  const targetKey = documentKey(reference.collection, reference.id);
  if (!indexed.has(targetKey)) {
    if (reference.required !== false)
      throw new Error(
        `PORTABILITY_DOCUMENT_REFERENCE_MISSING:${reference.collection}:${reference.id}`,
      );
    return false;
  }
  return select(
    selected,
    targetKey,
    `edge:${source.collection}:${source.document.id}#${reference.field}`,
  );
}

function selectMedia(
  indexed: ReadonlyMap<string, IndexedDocument>,
  selected: Map<string, Set<string>>,
  source: IndexedDocument,
  namespace: "asset" | "original",
  reference: PortabilityMediaReference,
): boolean {
  const collection = namespace === "asset" ? "assets" : "original_assets";
  const targetKey = documentKey(collection, reference.id);
  if (!indexed.has(targetKey))
    throw new Error(
      `PORTABILITY_MEDIA_REFERENCE_MISSING:${namespace}:${reference.id}`,
    );
  return select(
    selected,
    targetKey,
    `media:${source.collection}:${source.document.id}#${reference.field}`,
  );
}

function selectOwnedChildren(
  indexed: ReadonlyMap<string, IndexedDocument>,
  selected: Map<string, Set<string>>,
  root: PortabilityRoot,
): boolean {
  let changed = false;
  for (const source of indexed.values()) {
    if (selected.has(source.key)) continue;
    if (!supportsRoot(source.participant, root)) continue;
    for (const owner of source.participant.ownerReferences(source.document)) {
      if (root.kind === "project" && owner.collection === "customers") continue;
      if (!selected.has(documentKey(owner.collection, owner.id))) continue;
      changed =
        select(
          selected,
          source.key,
          `owner:${source.collection}:${source.document.id}#${owner.field}`,
        ) || changed;
      break;
    }
  }
  return changed;
}

function assertSingleRoot(
  indexed: ReadonlyMap<string, IndexedDocument>,
  selected: ReadonlyMap<string, Set<string>>,
  root: PortabilityRoot,
): void {
  for (const key of selected.keys()) {
    const item = indexed.get(key)!;
    if (root.kind === "project") {
      const other = item.participant
        .projectIds(item.document)
        .find((id) => id !== root.projectId);
      if (other)
        throw new Error(`PORTABILITY_SECOND_PROJECT_REACHABLE:${other}`);
    }
    const expectedCustomerId = root.customerId;
    const otherCustomer = item.participant
      .customerIds(item.document)
      .find((id) => id !== expectedCustomerId);
    if (otherCustomer)
      throw new Error(`PORTABILITY_SECOND_CUSTOMER_REACHABLE:${otherCustomer}`);
  }
}

function selectedDocuments(
  indexed: ReadonlyMap<string, IndexedDocument>,
  selected: ReadonlyMap<string, Set<string>>,
): readonly SelectedPortabilityDocument[] {
  return Object.freeze(
    [...selected]
      .map(([key, reasons]) => {
        const item = indexed.get(key)!;
        return Object.freeze({
          collection: item.collection,
          id: item.document.id,
          document: item.document,
          reasons: Object.freeze([...reasons].sort()),
        });
      })
      .sort(compareSelectedDocuments),
  );
}

function collectMediaReferences(
  indexed: ReadonlyMap<string, IndexedDocument>,
  selected: ReadonlyMap<string, Set<string>>,
): readonly SelectedPortabilityMediaReference[] {
  const result: SelectedPortabilityMediaReference[] = [];
  for (const key of selected.keys()) {
    const item = indexed.get(key)!;
    appendMedia(
      result,
      item,
      "asset",
      item.participant.assetReferences(item.document),
    );
    appendMedia(
      result,
      item,
      "original",
      item.participant.originalReferences(item.document),
    );
  }
  return Object.freeze(
    result.sort(compareMediaReferences).map((item) => Object.freeze(item)),
  );
}

function appendMedia(
  target: SelectedPortabilityMediaReference[],
  source: IndexedDocument,
  namespace: "asset" | "original",
  references: readonly PortabilityMediaReference[],
): void {
  for (const reference of references)
    target.push({
      namespace,
      id: reference.id,
      ownership: reference.ownership,
      sourceCollection: source.collection,
      sourceId: source.document.id,
      field: reference.field,
    });
}

function appendParticipantMedia(
  target: SelectedPortabilityMediaReference[],
  source: IndexedDocument,
): void {
  appendMedia(
    target,
    source,
    "asset",
    source.participant.assetReferences(source.document),
  );
  appendMedia(
    target,
    source,
    "original",
    source.participant.originalReferences(source.document),
  );
}

function uniqueMedia(
  references: readonly SelectedPortabilityMediaReference[],
  allReferences: readonly SelectedPortabilityMediaReference[],
): readonly SelectedPortabilityMedia[] {
  const counts = new Map<
    string,
    { occurrenceCount: number; ownedCount: number; referencedCount: number }
  >();
  const allCounts = countMediaOccurrences(allReferences);
  for (const reference of references) {
    const key = `${reference.namespace}:${reference.id}`;
    const count = counts.get(key) ?? {
      occurrenceCount: 0,
      ownedCount: 0,
      referencedCount: 0,
    };
    count.occurrenceCount += 1;
    count[reference.ownership === "owned" ? "ownedCount" : "referencedCount"] +=
      1;
    counts.set(key, count);
  }
  return Object.freeze(
    [...counts].map(([key, count]) => {
      const [namespace, id] = key.split(":") as ["asset" | "original", string];
      const outsideScopeOccurrenceCount =
        (allCounts.get(key) ?? 0) - count.occurrenceCount;
      if (outsideScopeOccurrenceCount < 0)
        throw new Error("PORTABILITY_MEDIA_OCCURRENCE_COUNT_INVALID");
      return Object.freeze({
        namespace,
        id,
        ...count,
        outsideScopeOccurrenceCount,
      });
    }),
  );
}

function countMediaOccurrences(
  references: readonly SelectedPortabilityMediaReference[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const reference of references) {
    const key = `${reference.namespace}:${reference.id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function supportsRoot(
  participant: PortabilityParticipant,
  root: PortabilityRoot,
): boolean {
  return participant.exportModes.includes(root.kind);
}

function select(
  selected: Map<string, Set<string>>,
  key: string,
  reason: string,
): boolean {
  const reasons = selected.get(key);
  if (reasons) {
    reasons.add(reason);
    return false;
  }
  selected.set(key, new Set([reason]));
  return true;
}

function documentKey(collection: string, id: string): string {
  return `${collection}:${id}`;
}

function compareSelectedDocuments(
  left: SelectedPortabilityDocument,
  right: SelectedPortabilityDocument,
): number {
  return (
    left.collection.localeCompare(right.collection) ||
    left.id.localeCompare(right.id)
  );
}

function compareMediaReferences(
  left: SelectedPortabilityMediaReference,
  right: SelectedPortabilityMediaReference,
): number {
  return (
    left.namespace.localeCompare(right.namespace) ||
    left.id.localeCompare(right.id) ||
    left.sourceCollection.localeCompare(right.sourceCollection) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.field.localeCompare(right.field) ||
    left.ownership.localeCompare(right.ownership)
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
