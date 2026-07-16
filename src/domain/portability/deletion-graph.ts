import { createHash } from "node:crypto";

import { canonicalJson } from "../../contracts/canonical-json.js";
import type { AssetRecord } from "../../assets/asset-store.js";
import type { OriginalAssetRecord } from "../../assets/original-asset-store.js";
import { projectSchema, projectVersionSchema } from "../authoring/schemas.js";
import { customerSchema } from "../library/schemas.js";
import type {
  BaseDocument,
  DocumentStore,
} from "../repository/document-store.js";
import type {
  DeletionBlockerLedgerEntry,
  DeletionDocumentLedgerEntry,
  DeletionExportLedgerEntry,
  DeletionJobLedgerEntry,
  DeletionMediaLedgerEntry,
  DeletionPreservedDocumentLedgerEntry,
} from "./deletion-ledger.js";
import type { DeletionTarget, DeletionTargetKind } from "./deletion-model.js";
import type {
  PortabilityDocumentReference,
  PortabilityParticipant,
  PortabilityRegistry,
} from "./participants.js";

interface StoredRow {
  collection: string;
  id: string;
  doc: string;
}

interface DeletionNode {
  key: string;
  collection: string;
  document: BaseDocument;
  participant: PortabilityParticipant;
}

interface OwnerRoots {
  customers: ReadonlySet<string>;
  projects: ReadonlySet<string>;
}

export interface DeletionGraphSelection {
  target: DeletionTarget;
  displayName: string;
  documents: readonly DeletionDocumentLedgerEntry[];
  jobs: readonly DeletionJobLedgerEntry[];
  exports: readonly DeletionExportLedgerEntry[];
  media: readonly DeletionMediaLedgerEntry[];
  preservedDocuments: readonly DeletionPreservedDocumentLedgerEntry[];
  blockers: readonly DeletionBlockerLedgerEntry[];
  deleteOrder: readonly {
    collection: string;
    id: string;
    document: BaseDocument;
  }[];
}

export function selectDeletionGraph(input: {
  store: DocumentStore;
  registry: PortabilityRegistry;
  target: { kind: DeletionTargetKind; id: string };
}): DeletionGraphSelection {
  const nodes = indexParticipantDocuments(input.store, input.registry);
  const targetFacts = requireTarget(nodes, input.target);
  const roots = resolveAllOwnerRoots(nodes);
  const selected = selectOwnedNodes(nodes, roots, targetFacts.target);
  const blockers = ownershipBlockers(selected, roots, targetFacts.target);
  const preserved = preservedReferences(
    nodes,
    selected,
    roots,
    targetFacts.target,
    blockers,
  );
  const facts = classifySelected(selected, input.registry);
  return Object.freeze({
    ...targetFacts,
    ...facts,
    media: mediaInventory(selected, nodes, blockers),
    preservedDocuments: preserved,
    blockers: Object.freeze(blockers.sort(compareBlockers)),
  });
}

function indexParticipantDocuments(
  store: DocumentStore,
  registry: PortabilityRegistry,
): ReadonlyMap<string, DeletionNode> {
  const participantCollections = new Set(
    registry.catalog.collections
      .filter((entry) => entry.owner === "participant")
      .map((entry) => entry.key),
  );
  const rows = store.database
    .prepare(
      "SELECT collection, id, doc FROM documents ORDER BY collection, id",
    )
    .all() as StoredRow[];
  const nodes = new Map<string, DeletionNode>();
  for (const row of rows) {
    if (!participantCollections.has(row.collection)) continue;
    const participant = registry.forCollection(row.collection);
    const document = participant.schema.parse(JSON.parse(row.doc));
    nodes.set(key(row.collection, row.id), {
      key: key(row.collection, row.id),
      collection: row.collection,
      document,
      participant,
    });
  }
  return nodes;
}

function requireTarget(
  nodes: ReadonlyMap<string, DeletionNode>,
  target: { kind: DeletionTargetKind; id: string },
): { target: DeletionTarget; displayName: string } {
  const node = nodes.get(
    key(target.kind === "customer" ? "customers" : "projects", target.id),
  );
  if (!node) fail("DELETION_TARGET_NOT_FOUND");
  if (target.kind === "customer") {
    const customer = customerSchema.parse(node.document);
    return targetResult(target, customer.id, customer.name, customer);
  }
  const project = projectSchema.parse(node.document);
  const versionNode = nodes.get(
    key("project_versions", project.currentVersionId),
  );
  if (!versionNode) fail("DELETION_TARGET_REVISION_NOT_FOUND");
  const version = projectVersionSchema.parse(versionNode.document);
  return targetResult(
    target,
    project.customerId,
    version.storyConfig.title,
    project,
  );
}

function targetResult(
  target: { kind: DeletionTargetKind; id: string },
  customerId: string,
  displayName: string,
  revision: unknown,
): { target: DeletionTarget; displayName: string } {
  return {
    target: {
      kind: target.kind,
      id: target.id,
      customerId,
      idHash: hash({ kind: target.kind, id: target.id }),
      revisionHash: hash(revision),
      displayNameHash: hash(displayName),
    },
    displayName,
  };
}

function resolveAllOwnerRoots(
  nodes: ReadonlyMap<string, DeletionNode>,
): ReadonlyMap<string, OwnerRoots> {
  const memo = new Map<string, OwnerRoots>();
  for (const node of nodes.values())
    resolveOwnerRoots(node, nodes, memo, new Set());
  return memo;
}

function resolveOwnerRoots(
  node: DeletionNode,
  nodes: ReadonlyMap<string, DeletionNode>,
  memo: Map<string, OwnerRoots>,
  visiting: Set<string>,
): OwnerRoots {
  const existing = memo.get(node.key);
  if (existing) return existing;
  if (visiting.has(node.key)) fail("DELETION_OWNER_CYCLE");
  visiting.add(node.key);
  let roots = directRoot(node);
  const ownerReferences = node.participant.ownerReferences(node.document);
  for (const reference of ownerReferences)
    roots = mergeRoots(
      roots,
      ownerRootsForReference(reference, nodes, memo, visiting),
    );
  if (ownerReferences.length === 0)
    roots = mergeRoots(roots, declaredRoots(node));
  visiting.delete(node.key);
  memo.set(node.key, roots);
  return roots;
}

function ownerRootsForReference(
  reference: PortabilityDocumentReference,
  nodes: ReadonlyMap<string, DeletionNode>,
  memo: Map<string, OwnerRoots>,
  visiting: Set<string>,
): OwnerRoots {
  const owner = nodes.get(key(reference.collection, reference.id));
  if (!owner) {
    if (reference.required !== false) fail("DELETION_OWNER_REFERENCE_MISSING");
    return emptyRoots();
  }
  return resolveOwnerRoots(owner, nodes, memo, visiting);
}

function directRoot(node: DeletionNode): OwnerRoots {
  if (node.collection === "customers")
    return { customers: new Set([node.document.id]), projects: new Set() };
  if (node.collection === "projects")
    return {
      customers: new Set(node.participant.customerIds(node.document)),
      projects: new Set([node.document.id]),
    };
  return emptyRoots();
}

function declaredRoots(node: DeletionNode): OwnerRoots {
  return {
    customers: new Set(node.participant.customerIds(node.document)),
    projects: new Set(node.participant.projectIds(node.document)),
  };
}

function selectOwnedNodes(
  nodes: ReadonlyMap<string, DeletionNode>,
  roots: ReadonlyMap<string, OwnerRoots>,
  target: DeletionTarget,
): ReadonlyMap<string, DeletionNode> {
  const selected = new Map<string, DeletionNode>();
  for (const node of nodes.values()) {
    const owners = roots.get(node.key)!;
    const owned =
      target.kind === "project"
        ? owners.projects.has(target.id)
        : owners.customers.has(target.id) ||
          [...owners.projects].some(
            (id) => projectCustomer(nodes, id) === target.id,
          );
    if (owned) selected.set(node.key, node);
  }
  return selected;
}

function ownershipBlockers(
  selected: ReadonlyMap<string, DeletionNode>,
  roots: ReadonlyMap<string, OwnerRoots>,
  target: DeletionTarget,
): DeletionBlockerLedgerEntry[] {
  const blockers: DeletionBlockerLedgerEntry[] = [];
  for (const node of selected.values()) {
    const owners = roots.get(node.key)!;
    const foreign =
      target.kind === "project"
        ? [...owners.projects].some((id) => id !== target.id)
        : [...owners.customers].some((id) => id !== target.id);
    if (foreign) blockers.push(blocker("DELETION_SHARED_DOCUMENT", node));
  }
  return blockers;
}

function preservedReferences(
  nodes: ReadonlyMap<string, DeletionNode>,
  selected: ReadonlyMap<string, DeletionNode>,
  roots: ReadonlyMap<string, OwnerRoots>,
  target: DeletionTarget,
  blockers: DeletionBlockerLedgerEntry[],
): readonly DeletionPreservedDocumentLedgerEntry[] {
  const preserved = new Map<string, DeletionPreservedDocumentLedgerEntry>();
  for (const node of selected.values()) {
    for (const reference of node.participant.references(node.document)) {
      if (
        reference.collection === "assets" ||
        reference.collection === "original_assets"
      )
        continue;
      const referenced = nodes.get(key(reference.collection, reference.id));
      if (!referenced || selected.has(referenced.key)) continue;
      if (isForeignReference(roots.get(referenced.key)!, target)) {
        blockers.push(blocker("DELETION_FOREIGN_REFERENCE", referenced));
        continue;
      }
      preserved.set(referenced.key, {
        entryType: "deletion_preserved_document",
        collection: referenced.collection,
        documentId: referenced.document.id,
        revisionHash: hash(referenced.document),
      });
    }
  }
  return Object.freeze([...preserved.values()].sort(compareDocuments));
}

function isForeignReference(
  roots: OwnerRoots,
  target: DeletionTarget,
): boolean {
  if (target.kind === "customer")
    return roots.customers.size > 0 && !roots.customers.has(target.id);
  return roots.customers.size > 0 && !roots.customers.has(target.customerId);
}

function classifySelected(
  selected: ReadonlyMap<string, DeletionNode>,
  registry: PortabilityRegistry,
): Pick<
  DeletionGraphSelection,
  "documents" | "jobs" | "exports" | "deleteOrder"
> {
  const documents: DeletionDocumentLedgerEntry[] = [];
  const jobs: DeletionJobLedgerEntry[] = [];
  const exports: DeletionExportLedgerEntry[] = [];
  for (const node of selected.values())
    classifyNode(node, documents, jobs, exports);
  const ranks = new Map(
    registry.participants.map((item, index) => [item.key, index]),
  );
  const deleteOrder = [...selected.values()]
    .sort(
      (left, right) =>
        rootDeleteRank(left) - rootDeleteRank(right) ||
        ranks.get(right.participant.key)! - ranks.get(left.participant.key)! ||
        left.document.id.localeCompare(right.document.id),
    )
    .map((node) => ({
      collection: node.collection,
      id: node.document.id,
      document: node.document,
    }));
  return {
    documents: Object.freeze(documents.sort(compareDocuments)),
    jobs: Object.freeze(jobs.sort((a, b) => a.jobId.localeCompare(b.jobId))),
    exports: Object.freeze(
      exports.sort((a, b) => a.exportId.localeCompare(b.exportId)),
    ),
    deleteOrder: Object.freeze(deleteOrder),
  };
}

function rootDeleteRank(node: DeletionNode): number {
  if (node.collection === "customers") return 2;
  return node.collection === "projects" ? 1 : 0;
}

function classifyNode(
  node: DeletionNode,
  documents: DeletionDocumentLedgerEntry[],
  jobs: DeletionJobLedgerEntry[],
  exports: DeletionExportLedgerEntry[],
): void {
  if (node.collection === "jobs") {
    const job = node.document as BaseDocument & {
      revision: number;
      state: string;
    };
    jobs.push({
      entryType: "deletion_job",
      jobId: job.id,
      revision: job.revision,
      state: job.state,
      revisionHash: hash(job),
    });
    return;
  }
  if (node.collection === "managed_exports") {
    const item = node.document as BaseDocument & {
      archiveChecksum: string;
      bytes: number;
    };
    exports.push({
      entryType: "deletion_export",
      exportId: item.id,
      checksum: item.archiveChecksum,
      bytes: item.bytes,
    });
  }
  documents.push({
    entryType: "deletion_document",
    collection: node.collection,
    documentId: node.document.id,
    revisionHash: hash(node.document),
  });
}

function mediaInventory(
  selected: ReadonlyMap<string, DeletionNode>,
  all: ReadonlyMap<string, DeletionNode>,
  blockers: DeletionBlockerLedgerEntry[],
): readonly DeletionMediaLedgerEntry[] {
  const references = new Map<string, { owned: number; referenced: number }>();
  for (const node of selected.values()) {
    countMedia(
      references,
      "asset",
      node.participant.assetReferences(node.document),
    );
    countMedia(
      references,
      "original",
      node.participant.originalReferences(node.document),
    );
  }
  const result: DeletionMediaLedgerEntry[] = [];
  for (const [mediaKey, counts] of references) {
    const [namespace, id] = mediaKey.split(":") as [
      "asset" | "original",
      string,
    ];
    const mediaNode = all.get(
      key(namespace === "asset" ? "assets" : "original_assets", id),
    );
    if (!mediaNode) {
      blockers.push(
        blockerForMedia("DELETION_MEDIA_RECORD_MISSING", namespace, id),
      );
      continue;
    }
    result.push(mediaEntry(namespace, mediaNode.document, counts, blockers));
  }
  return Object.freeze(result.sort(compareMedia));
}

function countMedia(
  result: Map<string, { owned: number; referenced: number }>,
  namespace: "asset" | "original",
  refs: readonly { id: string; ownership: "owned" | "referenced" }[],
): void {
  for (const ref of refs) {
    const mediaKey = `${namespace}:${ref.id}`;
    const count = result.get(mediaKey) ?? { owned: 0, referenced: 0 };
    count[ref.ownership] += 1;
    result.set(mediaKey, count);
  }
}

function mediaEntry(
  namespace: "asset" | "original",
  document: BaseDocument,
  counts: { owned: number; referenced: number },
  blockers: DeletionBlockerLedgerEntry[],
): DeletionMediaLedgerEntry {
  const record = document as AssetRecord | OriginalAssetRecord;
  if (record.refCount < counts.owned)
    blockers.push(
      blockerForMedia(
        "DELETION_MEDIA_REFCOUNT_UNDERFLOW",
        namespace,
        record.id,
      ),
    );
  const remaining = Math.max(0, record.refCount - counts.owned);
  return {
    entryType: "deletion_media",
    namespace,
    mediaId: record.id,
    checksum: record.sha256,
    ownedRefs: counts.owned,
    referencedRefs: counts.referenced,
    totalRefs: Math.max(record.refCount, counts.owned),
    expectedRemainingRefs: remaining,
    disposition:
      remaining === 0 ? "unlink_pending" : "shared_reference_preserved",
  };
}

function projectCustomer(
  nodes: ReadonlyMap<string, DeletionNode>,
  id: string,
): string | null {
  const node = nodes.get(key("projects", id));
  if (!node) return null;
  return projectSchema.parse(node.document).customerId;
}

function blocker(code: string, node: DeletionNode): DeletionBlockerLedgerEntry {
  return {
    entryType: "deletion_blocker",
    code,
    subjectKind: node.collection,
    subjectId: hash(node.key),
  };
}

function blockerForMedia(
  code: string,
  namespace: string,
  id: string,
): DeletionBlockerLedgerEntry {
  return {
    entryType: "deletion_blocker",
    code,
    subjectKind: namespace,
    subjectId: hash(`${namespace}:${id}`),
  };
}

function mergeRoots(left: OwnerRoots, right: OwnerRoots): OwnerRoots {
  return {
    customers: new Set([...left.customers, ...right.customers]),
    projects: new Set([...left.projects, ...right.projects]),
  };
}

function emptyRoots(): OwnerRoots {
  return { customers: new Set(), projects: new Set() };
}

function compareDocuments(
  left: { collection: string; documentId: string },
  right: { collection: string; documentId: string },
): number {
  return (
    left.collection.localeCompare(right.collection) ||
    left.documentId.localeCompare(right.documentId)
  );
}

function compareMedia(
  left: DeletionMediaLedgerEntry,
  right: DeletionMediaLedgerEntry,
): number {
  return (
    left.namespace.localeCompare(right.namespace) ||
    left.mediaId.localeCompare(right.mediaId)
  );
}

function compareBlockers(
  left: DeletionBlockerLedgerEntry,
  right: DeletionBlockerLedgerEntry,
): number {
  return (
    left.code.localeCompare(right.code) ||
    left.subjectKind.localeCompare(right.subjectKind) ||
    left.subjectId.localeCompare(right.subjectId)
  );
}

function key(collection: string, id: string): string {
  return `${collection}:${id}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function fail(code: string): never {
  throw new Error(code);
}
