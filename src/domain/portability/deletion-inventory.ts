import { createHash } from "node:crypto";

import { canonicalJson } from "../../contracts/canonical-json.js";
import type { DocumentStore } from "../repository/document-store.js";
import {
  type DeletionBlockerLedgerEntry,
  type DeletionDocumentLedgerEntry,
  type DeletionExportLedgerEntry,
  type DeletionJobLedgerEntry,
  type DeletionMediaLedgerEntry,
  type DeletionPreservedDocumentLedgerEntry,
} from "./deletion-ledger.js";
import {
  selectDeletionGraph,
  type DeletionGraphSelection,
} from "./deletion-graph.js";
import {
  deletionInventorySchema,
  type DeletionInventory,
  type DeletionTargetKind,
} from "./deletion-model.js";
import type { PortabilityRegistry } from "./participants.js";
import {
  hashLedgerPage,
  hashLedgerRoot,
  type PortabilityLedgerRepository,
  type PortabilityLedgerRoot,
} from "./repositories.js";
import {
  PORTABILITY_LEDGER_PAGE_SIZE,
  type PortabilityLedgerEntry,
  type PortabilityLedgerKind,
} from "./schemas.js";

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface DeletionInventorySnapshot {
  inventory: DeletionInventory;
  displayName: string;
  inventoryEntries: readonly PortabilityLedgerEntry[];
  blockerEntries: readonly DeletionBlockerLedgerEntry[];
  deleteOrder: DeletionGraphSelection["deleteOrder"];
}

export function buildDeletionInventory(input: {
  store: DocumentStore;
  registry: PortabilityRegistry;
  target: { kind: DeletionTargetKind; id: string };
  nowIso: string;
  additionalBlockers?: readonly DeletionBlockerLedgerEntry[];
}): DeletionInventorySnapshot {
  const graph = selectDeletionGraph(input);
  const blockers = canonicalEntries([
    ...graph.blockers,
    ...(input.additionalBlockers ?? []),
  ]);
  const inventoryEntries = canonicalEntries([
    ...graph.documents,
    ...graph.jobs,
    ...graph.exports,
    ...graph.media,
    ...graph.preservedDocuments,
  ]);
  const identity = inventoryIdentity(
    input.registry.hash,
    graph,
    inventoryEntries,
    blockers,
  );
  const inventoryId = entityIdFromHash(
    hash({ identity, createdAt: input.nowIso }),
  );
  const inventoryRoot = projectedRoot(
    inventoryId,
    "deletion_inventory",
    inventoryEntries,
  );
  const blockerRoot = projectedRoot(inventoryId, "deletion_blockers", blockers);
  const inventory = createDeletionInventory({
    inventoryId,
    nowIso: input.nowIso,
    registryHash: input.registry.hash,
    graph,
    blockers,
    inventoryRoot,
    blockerRoot,
  });
  return freezeInventorySnapshot(inventory, graph, inventoryEntries, blockers);
}

function freezeInventorySnapshot(
  inventory: DeletionInventory,
  graph: DeletionGraphSelection,
  inventoryEntries: PortabilityLedgerEntry[],
  blockers: DeletionBlockerLedgerEntry[],
): DeletionInventorySnapshot {
  return Object.freeze({
    inventory,
    displayName: graph.displayName,
    inventoryEntries: Object.freeze(inventoryEntries),
    blockerEntries: Object.freeze(blockers),
    deleteOrder: graph.deleteOrder,
  });
}

function createDeletionInventory(input: {
  inventoryId: string;
  nowIso: string;
  registryHash: string;
  graph: DeletionGraphSelection;
  blockers: readonly DeletionBlockerLedgerEntry[];
  inventoryRoot: PortabilityLedgerRoot;
  blockerRoot: PortabilityLedgerRoot;
}): DeletionInventory {
  const counts = deletionCounts(input.graph, input.blockers.length);
  const identity = {
    target: input.graph.target,
    participantRegistryHash: input.registryHash,
    counts,
    inventoryLedgerRoot: input.inventoryRoot.rootHash,
    blockerLedgerRoot: input.blockerRoot.rootHash,
  };
  return deletionInventorySchema.parse({
    id: input.inventoryId,
    schemaVersion: 1,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    target: input.graph.target,
    participantRegistryHash: input.registryHash,
    counts,
    inventoryPageCount: input.inventoryRoot.pageCount,
    inventoryLedgerRoot: input.inventoryRoot.rootHash,
    blockerPageCount: input.blockerRoot.pageCount,
    blockerLedgerRoot: input.blockerRoot.rootHash,
    inventoryHash: hash(identity),
  });
}

function deletionCounts(
  graph: DeletionGraphSelection,
  blockers: number,
): DeletionInventory["counts"] {
  return {
    documents: graph.documents.length,
    jobs: graph.jobs.length,
    exports: graph.exports.length,
    media: graph.media.length,
    blockers,
    sharedPreserved: graph.media.filter(
      (item) => item.disposition === "shared_reference_preserved",
    ).length,
    preservedDocuments: graph.preservedDocuments.length,
  };
}

export function persistDeletionInventoryPages(input: {
  store: DocumentStore;
  repository: PortabilityLedgerRepository;
  snapshot: DeletionInventorySnapshot;
  nowIso: string;
  idFactory: () => string;
}): void {
  writePages(input, "deletion_inventory", input.snapshot.inventoryEntries);
  writePages(input, "deletion_blockers", input.snapshot.blockerEntries);
  const inventoryRoot = input.repository.root(
    input.snapshot.inventory.id,
    "deletion_inventory",
  );
  const blockerRoot = input.repository.root(
    input.snapshot.inventory.id,
    "deletion_blockers",
  );
  if (
    inventoryRoot.rootHash !== input.snapshot.inventory.inventoryLedgerRoot ||
    blockerRoot.rootHash !== input.snapshot.inventory.blockerLedgerRoot
  )
    throw new Error("DELETION_INVENTORY_LEDGER_MISMATCH");
}

function writePages(
  input: Parameters<typeof persistDeletionInventoryPages>[0],
  ledgerKind: "deletion_inventory" | "deletion_blockers",
  entries: readonly PortabilityLedgerEntry[],
): void {
  for (const [pageIndex, pageEntries] of chunks(entries).entries()) {
    input.repository.appendPageInTransaction({
      id: input.idFactory(),
      schemaVersion: 1,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
      operationId: input.snapshot.inventory.id,
      ledgerKind,
      pageIndex,
      entries: pageEntries,
      pageHash: hashLedgerPage({
        operationId: input.snapshot.inventory.id,
        ledgerKind,
        pageIndex,
        entries: pageEntries,
      }),
    });
  }
}

function projectedRoot(
  operationId: string,
  ledgerKind: PortabilityLedgerKind,
  entries: readonly PortabilityLedgerEntry[],
): PortabilityLedgerRoot {
  const pages = chunks(entries).map((pageEntries, pageIndex) => ({
    pageIndex,
    entryCount: pageEntries.length,
    pageHash: hashLedgerPage({
      operationId,
      ledgerKind,
      pageIndex,
      entries: pageEntries,
    }),
  }));
  return {
    operationId,
    ledgerKind,
    pageCount: pages.length,
    entryCount: entries.length,
    rootHash: hashLedgerRoot(operationId, ledgerKind, pages),
  };
}

function inventoryIdentity(
  registryHash: string,
  graph: DeletionGraphSelection,
  entries: readonly PortabilityLedgerEntry[],
  blockers: readonly DeletionBlockerLedgerEntry[],
): unknown {
  return {
    target: graph.target,
    participantRegistryHash: registryHash,
    entries,
    blockers,
  };
}

function canonicalEntries<T extends PortabilityLedgerEntry>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function chunks<T>(entries: readonly T[]): T[][] {
  const result: T[][] = [];
  for (
    let index = 0;
    index < entries.length;
    index += PORTABILITY_LEDGER_PAGE_SIZE
  )
    result.push(entries.slice(index, index + PORTABILITY_LEDGER_PAGE_SIZE));
  return result;
}

function entityIdFromHash(value: string): string {
  let number = BigInt(`0x${value.slice(0, 32)}`);
  let result = "";
  for (let index = 0; index < 26; index += 1) {
    result = crockford[Number(number & 31n)] + result;
    number >>= 5n;
  }
  return result;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export type DeletionInventoryEntry =
  | DeletionDocumentLedgerEntry
  | DeletionJobLedgerEntry
  | DeletionExportLedgerEntry
  | DeletionMediaLedgerEntry
  | DeletionPreservedDocumentLedgerEntry;
