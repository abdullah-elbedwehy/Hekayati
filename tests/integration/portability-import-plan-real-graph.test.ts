import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { canonicalJson } from "../../src/contracts/canonical-json.js";
import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import {
  pauseProjectExportRequestHash,
  ProjectExportService,
  startProjectExportRequestHash,
} from "../../src/domain/portability/export-service.js";
import { rewritePortabilityParticipantIds } from "../../src/domain/portability/import-id-rules.js";
import { ImportPlanService } from "../../src/domain/portability/import-plan.js";
import { ImportPlanRepository } from "../../src/domain/portability/import-plan-storage.js";
import { DocumentStoreImportPlanTargetReader } from "../../src/domain/portability/import-plan-target.js";
import { rebaseParticipantDerivedFields } from "../../src/domain/portability/import-rebase.js";
import { ImportOperationRepository } from "../../src/domain/portability/import-storage.js";
import {
  createPortabilityRegistry,
  definePortabilityParticipant,
  extendPortabilityCatalog,
  REAL_PORTABILITY_CATALOG,
} from "../../src/domain/portability/participants.js";
import { realPortabilityParticipants } from "../../src/domain/portability/real-participants.js";
import {
  PortabilityActionRepository,
  PortabilityLedgerRepository,
} from "../../src/domain/portability/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { ManagedExportStore } from "../../src/portability/managed-export-store.js";
import { SnapshotStagingStore } from "../../src/portability/staging-store.js";
import {
  createPortabilityFixture,
  syntheticStudioFixtureSchema,
  type PortabilityFixture,
} from "../helpers/portability-fixture.js";
import { fixtureScheduler } from "../helpers/portability-fixture/support.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("real 003-009 import plan graph", () => {
  it("exports, validates, and plans the complete graph with no product writes", async () => {
    const fixture = await trackedFixture();
    const registry = fullRegistry();
    const ready = await exportReady(fixture, registry);
    const target = await temporaryDirectory("hekayati-real-plan-target-");
    cleanups.push(target.cleanup);
    const paths = resolveDataPaths(join(target.path, "data"));
    await prepareDataPaths(paths);
    const store = new DocumentStore(paths.database);
    cleanups.push(async () => store.close());
    const operations = new ImportOperationRepository(store);
    const actions = new PortabilityActionRepository(store);
    const plans = new ImportPlanRepository(store);
    const source = validatedSourceFacts(fixture, ready);
    const operation = seedPlanReadyOperation(
      store,
      operations,
      registry.hash,
      ready.managedExport.archiveChecksum,
      ready.manifest.manifestHash,
      source,
      ready.manifest.totalUncompressedBytes,
    );
    const sourceBundle = {
      root: fixture.scope,
      documents: source.documents,
      media: source.media,
      graphHash: source.graphHash,
      sourceSnapshotHash: source.sourceSnapshotHash,
      migratedDocumentCount: 0,
    };
    const request = {
      idempotencyKey: "real-graph-plan",
      expectedOperationRevision: operation.revision,
      mode: "as_new_project",
      sourceRoot: {
        projectId: fixture.scope.projectId,
        customerId: fixture.scope.customerId,
        familyId: fixture.scope.familyId,
      },
      customerResolution: { kind: "create_from_archive" },
      replaceTarget: null,
      selectedCharacterIds: [],
      selectedTemplateIds: [],
      templateCatalogRevisionHash: null,
      explicitMappings: [],
      approvalPolicy: "preserve_if_proven",
    };
    const service = new ImportPlanService(
      store,
      operations,
      plans,
      actions,
      new PortabilityLedgerRepository(store),
      registry,
      new DocumentStoreImportPlanTargetReader(store),
    );

    const result = service.plan(operation.id, request, sourceBundle);

    expect(result.plan.counts.writes).toBeGreaterThan(40);
    expect(result.plan.counts.preparedMedia).toBeGreaterThan(5);
    expect(result.plan.counts.jobsPaused).toBe(0);
    expect(result.plan.counts.approvalsPreserved).toBe(1);
    const demoted = service.plan(
      operation.id,
      {
        ...request,
        idempotencyKey: "real-graph-plan-demote",
        expectedOperationRevision: result.current.revision,
        approvalPolicy: "demote",
      },
      sourceBundle,
    );
    expect(demoted.plan.counts.approvalsPreserved).toBe(0);
    expect(demoted.plan.counts.approvalsDemoted).toBe(1);
    expect(demoted.plan.id).not.toBe(result.plan.id);
    expect(plans.get(result.plan.id)).toEqual(result.plan);
    expect(
      productDocumentCount(
        store,
        ready.manifest.documents.map((entry) => entry.collection),
      ),
    ).toBe(0);
  }, 60_000);
});

async function trackedFixture(): Promise<PortabilityFixture> {
  const fixture = await createPortabilityFixture();
  cleanups.push(fixture.cleanup);
  return fixture;
}

function fullRegistry() {
  const studio = definePortabilityParticipant({
    key: "synthetic_studio_entries",
    collection: "synthetic_studio_entries",
    currentSchemaVersion: 1,
    schema: syntheticStudioFixtureSchema,
    dependencies: ["assets", "customers", "families", "projects"],
    claims: { scopedWriters: ["synthetic_studio.repository"] },
    selectForProject: (document, root) =>
      document.owner.kind === "customer" &&
      document.owner.customerId === root.customerId
        ? "customer_studio"
        : null,
    selectForCustomer: (document, root) =>
      document.owner.kind === "customer" &&
      document.owner.customerId === root.customerId
        ? "customer_studio"
        : null,
    projectIds: (document) => (document.projectId ? [document.projectId] : []),
    customerIds: (document) =>
      document.owner.kind === "customer" ? [document.owner.customerId] : [],
    ownerReferences: (document) =>
      document.owner.kind === "customer"
        ? [
            {
              collection: "customers",
              id: document.owner.customerId,
              field: "owner.customerId",
            },
            {
              collection: "families",
              id: document.owner.familyId,
              field: "owner.familyId",
            },
          ]
        : [],
    references: (document) =>
      document.projectId
        ? [
            {
              collection: "projects",
              id: document.projectId,
              field: "projectId",
            },
          ]
        : [],
    assetReferences: (document) => [
      { id: document.assetId, field: "assetId", ownership: "owned" },
    ],
    rewriteIds: (document, idMap) => {
      const ownerReferences =
        document.owner.kind === "customer"
          ? [
              {
                collection: "customers",
                id: document.owner.customerId,
                field: "owner.customerId",
              },
              {
                collection: "families",
                id: document.owner.familyId,
                field: "owner.familyId",
              },
            ]
          : [];
      const references = document.projectId
        ? [
            {
              collection: "projects",
              id: document.projectId,
              field: "projectId",
            },
          ]
        : [];
      const assetReferences = [
        { id: document.assetId, field: "assetId", ownership: "owned" as const },
      ];
      return rewritePortabilityParticipantIds({
        collection: "synthetic_studio_entries",
        document,
        idMap,
        ownerReferences,
        references,
        assetReferences,
        originalReferences: [],
      });
    },
    rebaseDerivedFields: (document, idMap) =>
      rebaseParticipantDerivedFields(
        "synthetic_studio_entries",
        document,
        idMap,
      ),
  });
  return createPortabilityRegistry(
    [...realPortabilityParticipants, studio],
    extendPortabilityCatalog(REAL_PORTABILITY_CATALOG, {
      collections: [{ key: "synthetic_studio_entries", owner: "participant" }],
      scopedWriters: [
        { key: "synthetic_studio.repository", owner: "participant" },
      ],
    }),
  );
}

async function exportReady(
  fixture: PortabilityFixture,
  registry: ReturnType<typeof fullRegistry>,
) {
  const service = new ProjectExportService({
    store: fixture.store,
    registry,
    assets: fixture.assets,
    originals: fixture.originals,
    scheduler: fixtureScheduler(fixture.store, ulid),
    stagingStore: new SnapshotStagingStore(
      join(fixture.paths.root, "export-staging"),
    ),
    managedStore: new ManagedExportStore(join(fixture.paths.root, "exports")),
    appVersion: "0.1.0-test",
  });
  const project = new AuthoringRepositories(fixture.store).projects.get(
    fixture.scope.projectId,
  );
  if (!project) throw new Error("REAL_PLAN_PROJECT_MISSING");
  const pauseRequest = {
    projectId: project.id,
    expectedProjectRevision: project.revision,
    idempotencyKey: "real-plan-export-pause",
    acknowledgedChildPhotos: true,
    acknowledgedNoAutomaticBackup: true,
  };
  const paused = service.pause({
    ...pauseRequest,
    requestHash: pauseProjectExportRequestHash(pauseRequest),
  });
  const startRequest = {
    projectId: project.id,
    operationId: paused.current.operation.id,
    expectedProjectRevision: paused.current.operation.projectRevision,
    expectedOperationRevision: paused.current.operation.revision,
    idempotencyKey: "real-plan-export-start",
  };
  const started = service.start({
    ...startRequest,
    requestHash: startProjectExportRequestHash(startRequest),
  });
  return service.execute(started.current.operation.id);
}

function validatedSourceFacts(
  fixture: PortabilityFixture,
  ready: Awaited<ReturnType<typeof exportReady>>,
) {
  const documents = ready.manifest.documents.map((entry) => {
    const row = fixture.store.database
      .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
      .get(entry.collection, entry.id) as { doc: string } | undefined;
    if (!row) throw new Error("REAL_PLAN_SOURCE_DOCUMENT_MISSING");
    const document = JSON.parse(row.doc);
    return {
      collection: entry.collection,
      id: entry.id,
      schemaVersion: entry.schemaVersion,
      sourceSha256: entry.sha256,
      normalizedSha256: hash(document),
      migrationCount: 0,
      document,
    };
  });
  const media = ready.manifest.media.map((entry) => {
    const collection =
      entry.namespace === "asset" ? "assets" : "original_assets";
    const row = fixture.store.database
      .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
      .get(collection, entry.assetId) as { doc: string } | undefined;
    if (!row) throw new Error("REAL_PLAN_SOURCE_MEDIA_MISSING");
    const record = JSON.parse(row.doc) as Record<string, unknown>;
    return {
      namespace: entry.namespace,
      id: entry.assetId,
      bytes: entry.bytes,
      sha256: entry.sha256,
      mime: entry.mime,
      extension: entry.extension,
      role: entry.role,
      inspection: syntheticInspection(entry, record),
    };
  });
  const identity = {
    manifest: ready.manifest.manifestHash,
    documents: documents.map((item) => ({
      collection: item.collection,
      id: item.id,
      normalizedSha256: item.normalizedSha256,
    })),
    media,
  };
  return {
    documents,
    media,
    graphHash: hash({ contract: "SyntheticValidatedRealGraph/v1", identity }),
    sourceSnapshotHash: hash({
      contract: "SyntheticValidatedRealSnapshot/v1",
      identity,
    }),
  };
}

function syntheticInspection(
  entry: Awaited<ReturnType<typeof exportReady>>["manifest"]["media"][number],
  record: Record<string, unknown>,
) {
  if (entry.mime === "application/pdf")
    return {
      kind: "pdf" as const,
      parseable: true as const,
      encrypted: false as const,
      prohibitedFeatureCount: 0 as const,
    };
  if (entry.role === "icc_profile")
    return {
      kind: "icc" as const,
      signature: "acsp" as const,
      channels: 4 as const,
      profileClass: "output" as const,
      checksum: entry.sha256,
    };
  if (entry.mime.startsWith("image/"))
    return {
      kind: "image" as const,
      decoded: true as const,
      format: imageFormat(entry.extension),
      width: typeof record.width === "number" ? record.width : 1,
      height: typeof record.height === "number" ? record.height : 1,
    };
  return { kind: "binary" as const, executable: false as const };
}

function imageFormat(extension: string) {
  if (extension === "jpg") return "jpeg" as const;
  if (extension === "jpeg") return "jpeg" as const;
  if (extension === "png") return "png" as const;
  if (extension === "webp") return "webp" as const;
  if (extension === "heic") return "heic" as const;
  return "heif" as const;
}

function seedPlanReadyOperation(
  store: DocumentStore,
  operations: ImportOperationRepository,
  registryHash: string,
  archiveHash: string,
  manifestHash: string,
  source: ReturnType<typeof validatedSourceFacts>,
  totalBytes: number,
) {
  const at = "2026-07-16T20:00:00.000Z";
  const uploaded = {
    id: ulid(),
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    state: "uploaded" as const,
    reservationKey: `${ulid()}.zip`,
    stagingKey: null,
    sourceArchiveHash: archiveHash,
    sourceArchiveBytes: Math.max(1, totalBytes),
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
      uploadActionId: ulid(),
      latestPlanActionId: null,
      commitActionId: null,
    },
    planId: null,
    failureCode: null,
    cleanupState: "none" as const,
  };
  store.transactionImmediate(() => operations.insertInTransaction(uploaded));
  const validating = {
    ...uploaded,
    revision: 1,
    state: "validating" as const,
    stagingKey: ulid(),
  };
  store.transactionImmediate(() =>
    operations.replaceInTransaction(validating, 0),
  );
  const planReady = {
    ...validating,
    revision: 2,
    state: "plan_ready" as const,
    manifestVersion: 2 as const,
    normalizedManifestHash: manifestHash,
    sourceSnapshotHash: source.sourceSnapshotHash,
    participantRegistryHash: registryHash,
    archiveMode: "project" as const,
    documentCount: source.documents.length,
    mediaCount: source.media.length,
    totalUncompressedBytes: Math.max(1, totalBytes),
    diskFacts: {
      freeBytes: 64 * 1024 ** 3,
      reserveBytes: 1024,
      requiredBytes: Math.max(1, totalBytes),
      declaredUncompressedBytes: Math.max(1, totalBytes),
      newContentBytes: source.media.reduce(
        (total, item) => total + item.bytes,
        0,
      ),
      canonicalDocumentBytes: source.documents.reduce(
        (total, item) => total + canonicalJson(item.document).length,
        0,
      ),
    },
    migrationSummary: {
      sourceManifestVersion: 2 as const,
      normalizedManifestVersion: 2 as const,
      migratedManifest: false,
      migratedDocumentCount: 0,
    },
  };
  store.transactionImmediate(() =>
    operations.replaceInTransaction(planReady, 1),
  );
  return planReady;
}

function productDocumentCount(
  store: DocumentStore,
  collectionValues: readonly string[],
): number {
  const collections = [...new Set(collectionValues)];
  const placeholders = collections.map(() => "?").join(",");
  const row = store.database
    .prepare(
      `SELECT COUNT(*) AS count FROM documents WHERE collection IN (${placeholders})`,
    )
    .get(...collections) as { count: number };
  return row.count;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
