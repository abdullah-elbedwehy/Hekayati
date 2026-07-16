import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { canonicalJson } from "../../src/contracts/canonical-json.js";
import { rewritePortabilityParticipantIds } from "../../src/domain/portability/import-id-rules.js";
import { ImportPlanService } from "../../src/domain/portability/import-plan.js";
import { ImportPlanRepository } from "../../src/domain/portability/import-plan-storage.js";
import { recompileStoredImportPlan } from "../../src/domain/portability/import-plan-replay.js";
import {
  DocumentStoreImportPlanTargetReader,
  hashImportTargetRevision,
  type ImportPlanTargetReader,
} from "../../src/domain/portability/import-plan-target.js";
import { rebaseParticipantDerivedFields } from "../../src/domain/portability/import-rebase.js";
import { ImportOperationRepository } from "../../src/domain/portability/import-storage.js";
import {
  createPortabilityRegistry,
  definePortabilityParticipant,
  type PortabilityDocumentReference,
} from "../../src/domain/portability/participants.js";
import {
  PortabilityActionRepository,
  PortabilityLedgerRepository,
} from "../../src/domain/portability/repositories.js";
import {
  DocumentRepository,
  DocumentStore,
  type BaseDocument,
} from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-16T19:00:00.000Z";
const sourceIds = {
  operation: id(1),
  uploadAction: id(2),
  customer: id(3),
  family: id(4),
  project: id(5),
  reservation: `${id(6)}.zip`,
  staging: id(7),
};

describe("ImportPlanService", () => {
  let store: DocumentStore | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    store?.close();
    await cleanup?.();
    store = undefined;
    cleanup = undefined;
  });

  it("atomically persists one immutable as-new plan and exactly replays it", async () => {
    const temp = await temporaryDirectory("hekayati-import-planner-");
    cleanup = temp.cleanup;
    store = new DocumentStore(join(temp.path, "planner.sqlite"));
    const registry = syntheticRegistry();
    const operations = new ImportOperationRepository(store, () => id(90));
    seedPlanReadyOperation(store, operations, registry.hash);
    const plans = new ImportPlanRepository(store);
    const actions = new PortabilityActionRepository(store);
    const ledgers = new PortabilityLedgerRepository(store);
    const generated = idSequence(20);
    const service = new ImportPlanService(
      store,
      operations,
      plans,
      actions,
      ledgers,
      registry,
      emptyTargetReader(),
      { nowIso: () => at, idFactory: generated },
    );
    const source = sourceBundle();
    const request = planRequest();

    const first = service.plan(sourceIds.operation, request, source);

    expect(first.replayed).toBe(false);
    expect(first.plan.mode).toBe("as_new_project");
    expect(first.plan.counts).toMatchObject({
      mappings: 3,
      writes: 3,
      rebases: 3,
      authorizations: 1,
    });
    expect(first.plan.target.projectId).not.toBe(sourceIds.project);
    expect(first.plan.ledgerRoots.importIdMap.entryCount).toBe(3);
    expect(first.current).toMatchObject({
      revision: 3,
      state: "plan_ready",
      mode: "as_new_project",
      planId: first.plan.id,
    });
    expect(plans.listByOperation(sourceIds.operation)).toEqual([first.plan]);
    expect(ledgers.pages(first.plan.id, "import_id_map")).toHaveLength(1);
    expect(
      ledgers.pages(first.plan.id, "import_authorizations")[0].entries,
    ).toContainEqual(
      expect.objectContaining({
        entryType: "import_authorization",
        authorizationKind: "local_consent",
        disposition: "historical",
        reasonCode: "LOCAL_RECONSENT_REQUIRED",
      }),
    );
    expect(
      store.database
        .prepare(
          "SELECT COUNT(*) AS count FROM documents WHERE collection IN ('customers','families','projects')",
        )
        .get(),
    ).toEqual({ count: 0 });

    const replayedPlan = recompileStoredImportPlan({
      plan: first.plan,
      source,
      ledgers,
      registry,
      target: emptyTargetReader(),
    });
    expect(replayedPlan.compiled.documents).toHaveLength(
      first.plan.counts.writes,
    );
    expect(replayedPlan.graphHash).toMatch(/^[a-f0-9]{64}$/);

    const replay = service.plan(sourceIds.operation, request, source);
    expect(replay.replayed).toBe(true);
    expect(replay.plan).toEqual(first.plan);
    expect(plans.listByOperation(sourceIds.operation)).toHaveLength(1);
    expect(
      actions.list().filter((item) => item.action === "import_plan"),
    ).toHaveLength(1);

    expect(() =>
      service.plan(
        sourceIds.operation,
        { ...request, approvalPolicy: "preserve_if_proven" },
        source,
      ),
    ).toThrow("PORTABILITY_ACTION_IDEMPOTENCY_COLLISION");
    expect(plans.listByOperation(sourceIds.operation)).toHaveLength(1);
  });

  it("pins same-customer local authority and an exact replace target without mutating it", async () => {
    const temp = await temporaryDirectory("hekayati-import-replace-plan-");
    cleanup = temp.cleanup;
    store = new DocumentStore(join(temp.path, "replace.sqlite"));
    const registry = syntheticRegistry();
    const operations = new ImportOperationRepository(store, () => id(90));
    seedPlanReadyOperation(store, operations, registry.hash);
    const local = seedLocalTarget(store);
    const plans = new ImportPlanRepository(store);
    const ledgers = new PortabilityLedgerRepository(store);
    const service = new ImportPlanService(
      store,
      operations,
      plans,
      new PortabilityActionRepository(store),
      ledgers,
      registry,
      new DocumentStoreImportPlanTargetReader(store),
      { nowIso: () => at, idFactory: idSequence(20) },
    );
    const request = {
      ...planRequest(),
      idempotencyKey: "replace-synthetic-once",
      mode: "replace_existing" as const,
      customerResolution: {
        kind: "map_existing_same_customer" as const,
        targetCustomerId: local.customer.id,
        targetFamilyId: local.family.id,
        targetCustomerRevisionHash: hashImportTargetRevision(local.customer),
        targetFamilyRevisionHash: hashImportTargetRevision(local.family),
        sameRealCustomerAttested: true,
      },
      replaceTarget: {
        projectId: local.project.id,
        projectRevision: local.project.revision,
        projectRevisionHash: hashImportTargetRevision(local.project),
        destructiveScopeConfirmed: true,
      },
    };

    const result = service.plan(sourceIds.operation, request, sourceBundle());

    expect(result.plan.target).toMatchObject({
      kind: "replace_project",
      customerId: local.customer.id,
      familyId: local.family.id,
      projectId: local.project.id,
      projectRevision: 5,
    });
    expect(result.plan.counts.writes).toBe(1);
    expect(
      ledgers.pages(result.plan.id, "import_writes")[0].entries,
    ).toContainEqual(
      expect.objectContaining({
        entryType: "import_write",
        collection: "projects",
        targetId: local.project.id,
        disposition: "replace",
      }),
    );
    expect(
      ledgers.pages(result.plan.id, "import_authorizations")[0].entries,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorizationKind: "local_consent",
          disposition: "local_authority",
        }),
        expect.objectContaining({
          authorizationKind: "customer_attestation",
          disposition: "local_authority",
        }),
      ]),
    );
    expect(
      new DocumentRepository(store, "customers", customerSchema).get(
        local.customer.id,
      ),
    ).toEqual(local.customer);
    expect(
      new DocumentRepository(store, "projects", projectSchema).get(
        local.project.id,
      ),
    ).toEqual(local.project);
  });
});

const baseFields = {
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

const customerSchema = z
  .object({
    ...baseFields,
    name: z.string(),
    whatsapp: z.string(),
    consent: z.unknown().nullable(),
  })
  .strict();
const familySchema = z
  .object({ ...baseFields, customerId: baseFields.id, name: z.string() })
  .strict();
const projectSchema = z
  .object({
    ...baseFields,
    customerId: baseFields.id,
    familyId: baseFields.id,
    revision: z.number().int().nonnegative(),
    status: z.enum(["draft", "preview_ready", "approved", "print_ready"]),
    paused: z.boolean(),
    currentContentApprovalId: baseFields.id.nullable(),
  })
  .strict();

function syntheticRegistry() {
  const customers = participant("customers", customerSchema, []);
  const families = participant(
    "families",
    familySchema,
    ["customers"],
    [{ collection: "customers", path: "customerId" }],
  );
  const projects = participant(
    "projects",
    projectSchema,
    ["customers", "families"],
    [
      { collection: "customers", path: "customerId" },
      { collection: "families", path: "familyId" },
    ],
  );
  return createPortabilityRegistry([customers, families, projects], {
    collections: ["customers", "families", "projects"].map((key) => ({
      key,
      owner: "participant" as const,
    })),
    assetRoles: [],
    jobTypes: [],
    scopedWriters: [],
  });
}

function participant(
  key: string,
  schema: z.ZodType<BaseDocument>,
  dependencies: readonly string[],
  paths: readonly { collection: string; path: string }[] = [],
) {
  const references = (document: Readonly<BaseDocument>) =>
    paths.map(({ collection, path }): PortabilityDocumentReference => ({
      collection,
      id: String((document as Readonly<Record<string, unknown>>)[path]),
      field: path,
    }));
  return definePortabilityParticipant({
    key,
    collection: key,
    currentSchemaVersion: 1,
    schema,
    dependencies,
    references,
    rewriteIds: (document, idMap) =>
      rewritePortabilityParticipantIds({
        collection: key,
        document,
        idMap,
        ownerReferences: [],
        references: references(document),
        assetReferences: [],
        originalReferences: [],
      }),
    rebaseDerivedFields: (document, idMap) =>
      rebaseParticipantDerivedFields(key, document, idMap),
  });
}

function sourceBundle() {
  const documents = [
    sourceDocument("customers", {
      id: sourceIds.customer,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      name: "Synthetic Customer",
      whatsapp: "000",
      consent: { granted: true },
    }),
    sourceDocument("families", {
      id: sourceIds.family,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      customerId: sourceIds.customer,
      name: "Synthetic Family",
    }),
    sourceDocument("projects", {
      id: sourceIds.project,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      customerId: sourceIds.customer,
      familyId: sourceIds.family,
      revision: 0,
      status: "draft",
      paused: false,
      currentContentApprovalId: null,
    }),
  ];
  return {
    root: {
      projectId: sourceIds.project,
      customerId: sourceIds.customer,
      familyId: sourceIds.family,
    },
    documents,
    media: [],
    graphHash: hash("graph"),
    sourceSnapshotHash: hash("snapshot"),
    migratedDocumentCount: 0,
  };
}

function sourceDocument(
  collection: string,
  document: BaseDocument & Record<string, unknown>,
) {
  return {
    collection,
    id: document.id,
    schemaVersion: document.schemaVersion,
    sourceSha256: hash(document),
    normalizedSha256: hash(document),
    migrationCount: 0,
    document,
  };
}

function seedPlanReadyOperation(
  store: DocumentStore,
  operations: ImportOperationRepository,
  registryHash: string,
): void {
  const uploaded = {
    id: sourceIds.operation,
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    state: "uploaded" as const,
    reservationKey: sourceIds.reservation,
    stagingKey: null,
    sourceArchiveHash: hash("archive"),
    sourceArchiveBytes: 10,
    manifestVersion: null,
    normalizedManifestHash: null,
    sourceSnapshotHash: null,
    participantRegistryHash: null,
    archiveMode: null,
    mode: null,
    documentCount: 0,
    mediaCount: 0,
    totalUncompressedBytes: 0,
    diskFacts: null,
    migrationSummary: null,
    actionRefs: {
      uploadActionId: sourceIds.uploadAction,
      latestPlanActionId: null,
      commitActionId: null,
    },
    planId: null,
    commit: null,
    failureCode: null,
    cleanupState: "none" as const,
  };
  store.transactionImmediate(() => operations.insertInTransaction(uploaded));
  const validating = {
    ...uploaded,
    revision: 1,
    state: "validating" as const,
    stagingKey: sourceIds.staging,
  };
  store.transactionImmediate(() =>
    operations.replaceInTransaction(validating, 0),
  );
  store.transactionImmediate(() =>
    operations.replaceInTransaction(
      {
        ...validating,
        revision: 2,
        state: "plan_ready",
        manifestVersion: 2,
        normalizedManifestHash: hash("manifest"),
        sourceSnapshotHash: hash("snapshot"),
        participantRegistryHash: registryHash,
        archiveMode: "project",
        documentCount: 3,
        mediaCount: 0,
        totalUncompressedBytes: 10,
        diskFacts: {
          freeBytes: 1_000,
          reserveBytes: 10,
          requiredBytes: 20,
          declaredUncompressedBytes: 10,
          newContentBytes: 0,
          canonicalDocumentBytes: 10,
        },
        migrationSummary: {
          sourceManifestVersion: 2,
          normalizedManifestVersion: 2,
          migratedManifest: false,
          migratedDocumentCount: 0,
        },
      },
      1,
    ),
  );
}

function planRequest() {
  return {
    idempotencyKey: "plan-synthetic-once",
    expectedOperationRevision: 2,
    mode: "as_new_project" as const,
    sourceRoot: {
      projectId: sourceIds.project,
      customerId: sourceIds.customer,
      familyId: sourceIds.family,
    },
    customerResolution: { kind: "create_from_archive" as const },
    replaceTarget: null,
    selectedCharacterIds: [],
    selectedTemplateIds: [],
    templateCatalogRevisionHash: null,
    explicitMappings: [],
    approvalPolicy: "demote" as const,
  };
}

function emptyTargetReader(): ImportPlanTargetReader {
  return {
    document: () => null,
    revisionHash: () => null,
    idExists: () => false,
    findExactMedia: () => null,
    templateCatalogRevisionHash: () => hash([]),
  };
}

function seedLocalTarget(store: DocumentStore) {
  const customer = customerSchema.parse({
    id: id(70),
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    name: "Local Same Customer",
    whatsapp: "LOCAL-CONTACT",
    consent: { granted: true, source: "local" },
  });
  const family = familySchema.parse({
    id: id(71),
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    customerId: customer.id,
    name: "Local Family",
  });
  const project = projectSchema.parse({
    id: id(72),
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    customerId: customer.id,
    familyId: family.id,
    revision: 5,
    status: "approved",
    paused: false,
    currentContentApprovalId: null,
  });
  new DocumentRepository(store, "customers", customerSchema).put(customer);
  new DocumentRepository(store, "families", familySchema).put(family);
  new DocumentRepository(store, "projects", projectSchema).put(project);
  return { customer, family, project };
}

function idSequence(start: number): () => string {
  let value = start;
  return () => id(value++);
}

function id(value: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `01K60000000000000000000000`
    .slice(0, 24)
    .concat(alphabet[Math.floor(value / 32)], alphabet[value % 32]);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
