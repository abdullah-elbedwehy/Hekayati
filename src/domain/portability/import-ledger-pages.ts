import type { DocumentStore } from "../repository/document-store.js";
import {
  assertPortabilityTransaction,
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

export type ImportLedgerKind =
  | "import_id_map"
  | "import_conflicts"
  | "import_writes"
  | "import_releases"
  | "import_rebases"
  | "prepared_media"
  | "import_authorizations";

export function previewImportLedgerRoot(
  operationId: string,
  ledgerKind: ImportLedgerKind,
  entries: readonly PortabilityLedgerEntry[],
): PortabilityLedgerRoot {
  const pages = chunks(entries).map((pageEntries, pageIndex) => ({
    pageIndex,
    pageHash: hashLedgerPage({
      operationId,
      ledgerKind,
      pageIndex,
      entries: pageEntries,
    }),
    entryCount: pageEntries.length,
  }));
  return {
    operationId,
    ledgerKind,
    pageCount: pages.length,
    entryCount: entries.length,
    rootHash: hashLedgerRoot(operationId, ledgerKind, pages),
  };
}

export function appendImportLedgerPages(input: {
  store: DocumentStore;
  repository: PortabilityLedgerRepository;
  operationId: string;
  ledgerKind: ImportLedgerKind;
  entries: readonly PortabilityLedgerEntry[];
  nowIso: string;
  idFactory: () => string;
}): PortabilityLedgerRoot {
  assertPortabilityTransaction(input.store);
  for (const [pageIndex, entries] of chunks(input.entries).entries()) {
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
  const root = input.repository.root(input.operationId, input.ledgerKind);
  const preview = previewImportLedgerRoot(
    input.operationId,
    input.ledgerKind,
    input.entries,
  );
  if (
    root.rootHash !== preview.rootHash ||
    root.pageCount !== preview.pageCount ||
    root.entryCount !== preview.entryCount
  )
    throw new Error("IMPORT_PLAN_LEDGER_ROOT_MISMATCH");
  return root;
}

export function importPlanLedgerRoot(root: PortabilityLedgerRoot): {
  pageCount: number;
  entryCount: number;
  rootHash: string;
} {
  return {
    pageCount: root.pageCount,
    entryCount: root.entryCount,
    rootHash: root.rootHash,
  };
}

export function isImportLedgerKind(
  value: PortabilityLedgerKind,
): value is ImportLedgerKind {
  return importLedgerKinds.has(value);
}

const importLedgerKinds = new Set<PortabilityLedgerKind>([
  "import_id_map",
  "import_conflicts",
  "import_writes",
  "import_releases",
  "import_rebases",
  "prepared_media",
  "import_authorizations",
]);

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
