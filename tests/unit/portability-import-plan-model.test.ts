import { describe, expect, it } from "vitest";

import {
  hashImportPlanConfirmation,
  importPlanRequestSchema,
  importPlanSchema,
} from "../../src/domain/portability/import-plan-model.js";

const at = "2026-07-16T18:00:00.000Z";
const ids = Array.from({ length: 12 }, (_, index) =>
  `01K50000000000000000000000`
    .slice(0, 25)
    .concat(index.toString(32).toUpperCase()),
);
const hash = (value: string) => value.repeat(64).slice(0, 64);

describe("ImportPlan contracts", () => {
  it("accepts one immutable bounded plan whose confirmation binds every root", () => {
    const candidate = plan();
    const parsed = importPlanSchema.parse({
      ...candidate,
      confirmationHash: hashImportPlanConfirmation(candidate),
    });

    expect(parsed.mode).toBe("as_new_project");
    expect(parsed.ledgerRoots.importIdMap.entryCount).toBe(4);
    expect(parsed.createdAt).toBe(parsed.updatedAt);
  });

  it("rejects mutable timestamps, a forged confirmation, and root/count drift", () => {
    const candidate = plan();
    const valid = {
      ...candidate,
      confirmationHash: hashImportPlanConfirmation(candidate),
    };

    expect(() =>
      importPlanSchema.parse({
        ...valid,
        updatedAt: "2026-07-16T18:00:01.000Z",
      }),
    ).toThrow("IMPORT_PLAN_IMMUTABLE");
    expect(() =>
      importPlanSchema.parse({ ...valid, confirmationHash: hash("f") }),
    ).toThrow("IMPORT_PLAN_CONFIRMATION_HASH_MISMATCH");
    expect(() =>
      importPlanSchema.parse({
        ...valid,
        counts: { ...valid.counts, mappings: 5 },
      }),
    ).toThrow("IMPORT_PLAN_LEDGER_COUNT_MISMATCH");
  });

  it("closes all four mode policies and exact customer/replace evidence", () => {
    expect(
      importPlanRequestSchema.parse({
        ...request(),
        mode: "as_new_project",
        customerResolution: { kind: "create_from_archive" },
      }).mode,
    ).toBe("as_new_project");
    expect(
      importPlanRequestSchema.parse({
        ...request(),
        mode: "characters_only",
        customerResolution: mappedCustomer(),
        selectedCharacterIds: [ids[7]],
      }).mode,
    ).toBe("characters_only");
    expect(
      importPlanRequestSchema.parse({
        ...request(),
        mode: "templates_only",
        customerResolution: null,
        selectedTemplateIds: [ids[8]],
        templateCatalogRevisionHash: hash("d"),
      }).mode,
    ).toBe("templates_only");
    expect(
      importPlanRequestSchema.parse({
        ...request(),
        mode: "replace_existing",
        customerResolution: mappedCustomer(),
        replaceTarget: {
          projectId: ids[6],
          projectRevision: 9,
          projectRevisionHash: hash("e"),
          destructiveScopeConfirmed: true,
        },
      }).mode,
    ).toBe("replace_existing");

    expect(() =>
      importPlanRequestSchema.parse({
        ...request(),
        mode: "replace_existing",
        customerResolution: mappedCustomer(),
      }),
    ).toThrow("IMPORT_PLAN_REPLACE_TARGET_REQUIRED");
    expect(() =>
      importPlanRequestSchema.parse({
        ...request(),
        customerResolution: {
          ...mappedCustomer(),
          sameRealCustomerAttested: false,
        },
      }),
    ).toThrow("IMPORT_PLAN_SAME_CUSTOMER_ATTESTATION_REQUIRED");
    expect(() =>
      importPlanRequestSchema.parse({
        ...request(),
        mode: "templates_only",
        customerResolution: null,
      }),
    ).toThrow("IMPORT_PLAN_TEMPLATE_SELECTION_REQUIRED");
  });
});

function request() {
  return {
    idempotencyKey: "plan-once",
    expectedOperationRevision: 2,
    mode: "as_new_project" as const,
    sourceRoot: {
      projectId: ids[1],
      customerId: ids[2],
      familyId: ids[3],
    },
    customerResolution: mappedCustomer(),
    replaceTarget: null,
    selectedCharacterIds: [],
    selectedTemplateIds: [],
    templateCatalogRevisionHash: null,
    explicitMappings: [],
    approvalPolicy: "preserve_if_proven" as const,
  };
}

function mappedCustomer() {
  return {
    kind: "map_existing_same_customer" as const,
    targetCustomerId: ids[4],
    targetFamilyId: ids[5],
    targetCustomerRevisionHash: hash("a"),
    targetFamilyRevisionHash: hash("b"),
    sameRealCustomerAttested: true,
  };
}

function plan() {
  const roots = {
    importIdMap: root(4, hash("1")),
    importConflicts: root(1, hash("2")),
    importWrites: root(3, hash("3")),
    importReleases: root(0, hash("4")),
    importRebases: root(3, hash("5")),
    preparedMedia: root(1, hash("6")),
    importAuthorizations: root(1, hash("7")),
  };
  return {
    id: ids[0],
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    operationId: ids[1],
    operationRevision: 2,
    mode: "as_new_project" as const,
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
      kind: "new_project" as const,
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
      kind: "create_from_archive" as const,
      attestationHash: null,
    },
    conflictChoicesHash: hash("f"),
    diskFactsHash: hash("8"),
    migrationFactsHash: hash("9"),
    sanitizationFactsHash: hash("0"),
    counts: {
      mappings: 4,
      conflicts: 1,
      writes: 3,
      releases: 0,
      rebases: 3,
      preparedMedia: 1,
      authorizations: 1,
      approvalsPreserved: 1,
      approvalsDemoted: 0,
      jobsPaused: 1,
    },
    ledgerRoots: roots,
  };
}

function root(entryCount: number, rootHash: string) {
  return {
    pageCount: entryCount === 0 ? 0 : 1,
    entryCount,
    rootHash,
  };
}
