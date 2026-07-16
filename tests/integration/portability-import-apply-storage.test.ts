import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PreparedImportMediaRepository,
} from "../../src/domain/portability/import-apply-storage.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-16T23:00:00.000Z";
const later = "2026-07-16T23:00:01.000Z";
const id = (digit: string) => `01KA000000000000000000000${digit}`;
const checksum = "a".repeat(64);

describe("PreparedImportMediaRepository", () => {
  let store: DocumentStore | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    store?.close();
    await cleanup?.();
    store = undefined;
    cleanup = undefined;
  });

  it("persists one exact reservation and CASes only valid state transitions", async () => {
    const temp = await temporaryDirectory("hekayati-import-apply-store-");
    cleanup = temp.cleanup;
    store = new DocumentStore(join(temp.path, "app.sqlite"));
    const repository = new PreparedImportMediaRepository(store);
    const reserved = row();

    const inserted = store.transactionImmediate(() =>
      repository.insertInTransaction(reserved),
    );
    expect(inserted).toEqual(reserved);
    expect(repository.list(id("2"))).toEqual([reserved]);
    expect(
      store.transactionImmediate(() =>
        repository.insertInTransaction(reserved),
      ),
    ).toEqual(reserved);

    const written = store.transactionImmediate(() =>
      repository.updateInTransaction(reserved, {
        ...reserved,
        revision: 1,
        updatedAt: later,
        state: "written",
      }),
    );
    expect(written.state).toBe("written");
    expect(() =>
      store!.transactionImmediate(() =>
        repository.updateInTransaction(written, {
          ...written,
          revision: 2,
          updatedAt: later,
          state: "reserved",
        }),
      ),
    ).toThrow("IMPORT_PREPARED_MEDIA_STATE_INVALID");
    expect(() =>
      store!.transactionImmediate(() =>
        repository.updateInTransaction(written, {
          ...written,
          revision: 2,
          updatedAt: later,
          metadataHash: "c".repeat(64),
          state: "committed",
        }),
      ),
    ).toThrow("IMPORT_PREPARED_MEDIA_IMMUTABLE_FIELD_CHANGED");
  });
});

function row() {
  return {
    id: id("1"),
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    operationId: id("2"),
    planId: id("3"),
    namespace: "asset" as const,
    sourceId: id("4"),
    targetId: id("5"),
    checksum,
    bytes: 10,
    metadataHash: "b".repeat(64),
    managedKey: `${checksum.slice(0, 2)}/${checksum}.png`,
    state: "reserved" as const,
    wasPreexisting: false,
    record: {
      id: id("5"),
      schemaVersion: 1 as const,
      createdAt: at,
      updatedAt: at,
      sha256: checksum,
      extension: "png",
      bytes: 10,
      refCount: 1,
      mime: "image/png",
      width: 1,
      height: 1,
      role: "illustration" as const,
      origin: "derived" as const,
    },
  };
}
