import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import {
  appendImportLedgerPages,
  previewImportLedgerRoot,
} from "../../src/domain/portability/import-ledger-pages.js";
import { PortabilityLedgerRepository } from "../../src/domain/portability/repositories.js";
import { portabilityLedgerPageSchema } from "../../src/domain/portability/schemas.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
const at = "2026-07-16T19:00:00.000Z";

afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("immutable import ledger pages", () => {
  it("bounds 257 mappings into two deterministic pages and matches preview", async () => {
    const temp = await temporaryDirectory("hekayati-import-ledgers-");
    const store = new DocumentStore(join(temp.path, "app.sqlite"));
    cleanups.push(async () => {
      store.close();
      await temp.cleanup();
    });
    const repository = new PortabilityLedgerRepository(store);
    const operationId = ulid();
    const entries = Array.from({ length: 257 }, () => ({
      entryType: "import_mapping" as const,
      namespace: "projects",
      sourceId: ulid(),
      targetId: ulid(),
      disposition: "fresh" as const,
      targetRevisionHash: null,
    })).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const preview = previewImportLedgerRoot(
      operationId,
      "import_id_map",
      entries,
    );
    const persisted = store.transactionImmediate(() =>
      appendImportLedgerPages({
        store,
        repository,
        operationId,
        ledgerKind: "import_id_map",
        entries,
        nowIso: at,
        idFactory: ulid,
      }),
    );

    expect(persisted).toEqual(preview);
    expect(persisted).toMatchObject({ pageCount: 2, entryCount: 257 });
    expect(
      repository.page(operationId, "import_id_map", 0)?.entries,
    ).toHaveLength(256);
    expect(
      repository.page(operationId, "import_id_map", 1)?.entries,
    ).toHaveLength(1);
  });

  it("rejects an import entry under the wrong ledger kind", () => {
    const entry = {
      entryType: "import_mapping" as const,
      namespace: "projects",
      sourceId: ulid(),
      targetId: ulid(),
      disposition: "fresh" as const,
      targetRevisionHash: null,
    };
    expect(() =>
      portabilityLedgerPageSchema.parse({
        id: ulid(),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        operationId: ulid(),
        ledgerKind: "import_writes",
        pageIndex: 0,
        entries: [entry],
        pageHash: "a".repeat(64),
      }),
    ).toThrow("PORTABILITY_LEDGER_ENTRY_KIND_MISMATCH");
  });
});
