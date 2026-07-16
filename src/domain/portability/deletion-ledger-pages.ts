import type { DocumentStore } from "../repository/document-store.js";
import type { ManagedUnlinkLedgerEntry } from "./deletion-ledger.js";
import {
  hashLedgerPage,
  type PortabilityLedgerRepository,
  type PortabilityLedgerRoot,
} from "./repositories.js";
import {
  PORTABILITY_LEDGER_PAGE_SIZE,
  type PortabilityLedgerEntry,
  type PortabilityLedgerKind,
} from "./schemas.js";

export function appendDeletionLedgerPages(input: {
  store: DocumentStore;
  repository: PortabilityLedgerRepository;
  operationId: string;
  ledgerKind:
    | "deletion_unlinks"
    | "shared_preservation"
    | "deletion_verification"
    | "report_detail";
  entries: readonly PortabilityLedgerEntry[];
  nowIso: string;
  idFactory: () => string;
}): PortabilityLedgerRoot {
  const start = input.repository.root(
    input.operationId,
    input.ledgerKind,
  ).pageCount;
  for (const [offset, entries] of chunks(input.entries).entries()) {
    const pageIndex = start + offset;
    input.repository.appendPageInTransaction({
      id: input.idFactory(),
      schemaVersion: 1,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
      operationId: input.operationId,
      ledgerKind: input.ledgerKind,
      pageIndex,
      entries,
      pageHash: hashLedgerPage({
        operationId: input.operationId,
        ledgerKind: input.ledgerKind,
        pageIndex,
        entries,
      }),
    });
  }
  return input.repository.root(input.operationId, input.ledgerKind);
}

export function latestManagedUnlinks(
  repository: PortabilityLedgerRepository,
  operationId: string,
): ManagedUnlinkLedgerEntry[] {
  const current = new Map<string, ManagedUnlinkLedgerEntry>();
  for (const page of repository.pages(operationId, "deletion_unlinks")) {
    for (const entry of page.entries) {
      if (entry.entryType !== "managed_unlink")
        throw new Error("DELETION_UNLINK_LEDGER_KIND_INVALID");
      const key = `${entry.namespace}:${entry.mediaId}`;
      const prior = current.get(key);
      if (!prior || entry.attempts >= prior.attempts) current.set(key, entry);
    }
  }
  return [...current.values()].sort(
    (left, right) =>
      left.namespace.localeCompare(right.namespace) ||
      left.mediaId.localeCompare(right.mediaId),
  );
}

export function assertDeletionLedgerRoot(
  repository: PortabilityLedgerRepository,
  operationId: string,
  ledgerKind: PortabilityLedgerKind,
  expected: string,
): void {
  if (repository.root(operationId, ledgerKind).rootHash !== expected)
    throw new Error("DELETION_LEDGER_ROOT_MISMATCH");
}

function chunks(
  entries: readonly PortabilityLedgerEntry[],
): PortabilityLedgerEntry[][] {
  const result: PortabilityLedgerEntry[][] = [];
  for (
    let index = 0;
    index < entries.length;
    index += PORTABILITY_LEDGER_PAGE_SIZE
  )
    result.push(entries.slice(index, index + PORTABILITY_LEDGER_PAGE_SIZE));
  return result;
}
