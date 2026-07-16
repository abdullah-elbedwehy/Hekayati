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
} from "./schemas.js";

export function appendImportCleanupPages(input: {
  store: DocumentStore;
  repository: PortabilityLedgerRepository;
  operationId: string;
  entries: readonly ManagedUnlinkLedgerEntry[];
  nowIso: string;
  idFactory: () => string;
}): PortabilityLedgerRoot {
  const ledgerKind = "import_unlinks" as const;
  const start = input.repository.root(input.operationId, ledgerKind).pageCount;
  for (const [offset, entries] of chunks(input.entries).entries()) {
    const pageIndex = start + offset;
    input.repository.appendPageInTransaction({
      id: input.idFactory(),
      schemaVersion: 1,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
      operationId: input.operationId,
      ledgerKind,
      pageIndex,
      entries,
      pageHash: hashLedgerPage({
        operationId: input.operationId,
        ledgerKind,
        pageIndex,
        entries,
      }),
    });
  }
  return input.repository.root(input.operationId, ledgerKind);
}

export function latestImportCleanupEntries(
  repository: PortabilityLedgerRepository,
  operationId: string,
): ManagedUnlinkLedgerEntry[] {
  const latest = new Map<string, ManagedUnlinkLedgerEntry>();
  for (const page of repository.pages(operationId, "import_unlinks")) {
    for (const entry of page.entries) {
      if (entry.entryType !== "managed_unlink")
        throw new Error("IMPORT_UNLINK_LEDGER_KIND_INVALID");
      const key = `${entry.namespace}:${entry.mediaId}`;
      const current = latest.get(key);
      if (!current || entry.attempts >= current.attempts)
        latest.set(key, entry);
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      left.namespace.localeCompare(right.namespace) ||
      left.mediaId.localeCompare(right.mediaId),
  );
}

function chunks(
  entries: readonly ManagedUnlinkLedgerEntry[],
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
