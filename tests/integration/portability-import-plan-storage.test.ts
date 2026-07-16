import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  hashImportPlanConfirmation,
  type ImportPlanCore,
} from "../../src/domain/portability/import-plan-model.js";
import { ImportPlanRepository } from "../../src/domain/portability/import-plan-storage.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-16T18:30:00.000Z";
const ids = Array.from({ length: 10 }, (_, index) =>
  `01K51000000000000000000000`.slice(0, 25).concat(index.toString(32)),
);
const hash = (value: string) => value.repeat(64).slice(0, 64);

describe("ImportPlanRepository", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let store: DocumentStore | undefined;

  afterEach(async () => {
    store?.close();
    await cleanup?.();
    store = undefined;
    cleanup = undefined;
  });

  it("persists immutable plans only inside the atomic transaction", async () => {
    const temp = await temporaryDirectory("hekayati-import-plan-");
    cleanup = temp.cleanup;
    store = new DocumentStore(join(temp.path, "plan.sqlite"));
    const repository = new ImportPlanRepository(store);
    const plan = completePlan();

    expect(() => repository.insertInTransaction(plan)).toThrow(
      "IMPORT_PLAN_TRANSACTION_REQUIRED",
    );
    store.transactionImmediate(() => repository.insertInTransaction(plan));

    expect(repository.get(plan.id)).toEqual(plan);
    expect(repository.listByOperation(plan.operationId)).toEqual([plan]);
    expect(() =>
      store!.transactionImmediate(() =>
        repository.insertInTransaction({
          ...plan,
          target: { ...plan.target, projectId: ids[8] },
        }),
      ),
    ).toThrow();
    expect(repository.get(plan.id)).toEqual(plan);
  });
});

function completePlan() {
  const core: ImportPlanCore = {
    id: ids[0],
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    operationId: ids[1],
    operationRevision: 2,
    mode: "as_new_project",
    source: {
      archiveHash: hash("a"),
      normalizedManifestHash: hash("b"),
      snapshotHash: hash("c"),
      participantRegistryHash: hash("d"),
      graphHash: hash("e"),
      projectId: ids[2],
      customerId: ids[3],
      familyId: ids[4],
    },
    target: {
      kind: "new_project",
      customerId: ids[5],
      familyId: ids[6],
      projectId: ids[7],
      customerRevisionHash: null,
      familyRevisionHash: null,
      projectRevision: null,
      projectRevisionHash: null,
      templateCatalogRevisionHash: null,
    },
    customerResolution: {
      kind: "create_from_archive",
      attestationHash: null,
    },
    conflictChoicesHash: hash("f"),
    diskFactsHash: hash("8"),
    migrationFactsHash: hash("9"),
    sanitizationFactsHash: hash("0"),
    counts: {
      mappings: 0,
      conflicts: 0,
      writes: 0,
      releases: 0,
      rebases: 0,
      preparedMedia: 0,
      authorizations: 0,
      approvalsPreserved: 0,
      approvalsDemoted: 0,
      jobsPaused: 0,
    },
    ledgerRoots: {
      importIdMap: root("1"),
      importConflicts: root("2"),
      importWrites: root("3"),
      importReleases: root("4"),
      importRebases: root("5"),
      preparedMedia: root("6"),
      importAuthorizations: root("7"),
    },
  };
  return { ...core, confirmationHash: hashImportPlanConfirmation(core) };
}

function root(seed: string) {
  return { pageCount: 0, entryCount: 0, rootHash: hash(seed) };
}
