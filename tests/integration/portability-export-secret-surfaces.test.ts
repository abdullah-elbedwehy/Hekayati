import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, type Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { assetRecordSchema } from "../../src/assets/asset-store.js";
import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { projectSchema } from "../../src/domain/authoring/schemas.js";
import {
  customerSchema,
  familySchema,
} from "../../src/domain/library/schemas.js";
import {
  pauseProjectExportRequestHash,
  ProjectExportService,
  startProjectExportRequestHash,
} from "../../src/domain/portability/export-service.js";
import type { ExportOperation } from "../../src/domain/portability/export-model.js";
import {
  createPortabilityRegistry,
  definePortabilityParticipant,
  type PortabilityRegistry,
} from "../../src/domain/portability/participants.js";
import {
  ManagedExportStore,
  type ManagedExportPublishInput,
} from "../../src/portability/managed-export-store.js";
import {
  writeDeterministicArchive,
  type StagedArchiveSource,
} from "../../src/portability/export.js";
import { createManifest } from "../../src/portability/manifest.js";
import { verifyFinalizedArchive } from "../../src/portability/release-gate.js";
import { SecretReleaseGate } from "../../src/portability/secret-scan.js";
import { SnapshotStagingStore } from "../../src/portability/staging-store.js";
import { SecretRegistry } from "../../src/security/secret-registry.js";
import {
  createPortabilityFixture,
  syntheticStudioFixtureSchema,
  type PortabilityFixture,
} from "../helpers/portability-fixture.js";
import { fixtureScheduler } from "../helpers/portability-fixture/support.js";
import { temporaryDirectory } from "../helpers/temp.js";

const canary = "HEKAYATI_SECRET_CANARY";
const cleanExportId = "01KZX48ZM9N74CRKFWQTJ76X2G";
const blockedExportId = "01KZX48ZM9N74CRKFWQTJ76X2H";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.each([
  {
    surface: "canonical JSON bytes",
    documentId: "project-clean-id",
    bytes: Buffer.from(`{"notes":"${canary}"}`),
    expectedFindingEntry: "data/projects/project-clean-id.json",
  },
  {
    surface: "generated manifest and entry name",
    documentId: canary,
    bytes: Buffer.from('{"notes":"synthetic clean document"}'),
    expectedFindingEntry: "manifest.json",
  },
])(
  "final release gate: $surface",
  ({ documentId, bytes, expectedFindingEntry }) => {
    it("removes only the rejected candidate and preserves prior ready bytes", async () => {
      const directory = await temporaryDirectory("hekayati-secret-release-");
      cleanups.push(directory.cleanup);
      const store = new ManagedExportStore(join(directory.path, "exports"));
      const prior = await publishLowLevel(
        store,
        lowLevelArchive(cleanExportId),
      );
      const priorPath = join(directory.path, "exports", prior.archiveKey);
      const priorBytes = await readFile(priorPath);
      const blocked = lowLevelArchive(blockedExportId, documentId, bytes);

      await expect(publishLowLevel(store, blocked)).rejects.toMatchObject({
        message: "PORTABILITY_EXPORT_SECRET_FOUND",
        finding: {
          category: "seeded_canary",
          entry: expectedFindingEntry,
        },
      });

      expect(await readdir(join(directory.path, "exports"))).toEqual([
        prior.archiveKey,
      ]);
      expect(await readFile(priorPath)).toEqual(priorBytes);
    });
  },
);

describe.each([
  { surface: "included binary media", injection: "binary" as const },
  {
    surface: "independent finalized-ZIP-only reread",
    injection: "final" as const,
  },
])("export orchestration: $surface", ({ injection }) => {
  it("fails closed without a new ready record or archive", async () => {
    const fixture = await trackedFixture();
    const registry = testRegistry();
    const clean = await createPriorReady(fixture, registry);
    const priorPath = join(fixture.paths.root, "exports", clean.archiveKey);
    const priorBytes = await readFile(priorPath);
    const finalStore = await prepareInjection(fixture, injection);
    const service = exportService(fixture, registry, finalStore.store);
    const operationId = startNextExport(fixture, service, injection);
    if (finalStore.seededMediaId)
      expect(snapshotMediaIds(fixture, operationId)).toContain(
        finalStore.seededMediaId,
      );

    await expect(service.execute(operationId)).rejects.toThrow(
      "PORTABILITY_EXPORT_EXECUTION_FAILED",
    );

    assertFailedCandidate(fixture, operationId, clean.operationId);
    expect(finalStore.verificationCalls()).toBe(injection === "final" ? 1 : 0);
    expect(await readdir(join(fixture.paths.root, "exports"))).toEqual([
      clean.archiveKey,
    ]);
    expect(await readFile(priorPath)).toEqual(priorBytes);
  }, 60_000);
});

async function createPriorReady(
  fixture: PortabilityFixture,
  registry: PortabilityRegistry,
) {
  const service = exportService(fixture, registry);
  const project = requireProject(fixture);
  const paused = service.pause(pauseInput(project, "secret-clean"));
  const started = service.start(
    startInput(paused.current.operation, "secret-clean"),
  );
  const ready = await service.execute(started.current.operation.id);
  return {
    operationId: ready.operation.id,
    archiveKey: ready.managedExport.archiveKey,
  };
}

async function prepareInjection(
  fixture: PortabilityFixture,
  injection: "binary" | "final",
) {
  const root = join(fixture.paths.root, "exports");
  if (injection === "final") {
    const store = new FinalPassSecretStore(root, () =>
      fixture.store.secretRegistry.register("fixture synthetic only"),
    );
    return {
      store,
      seededMediaId: null,
      verificationCalls: () => store.verificationCalls,
    };
  }
  const seededMediaId = await seedBinaryCanary(fixture);
  return {
    store: new ManagedExportStore(root),
    seededMediaId,
    verificationCalls: () => 0,
  };
}

async function seedBinaryCanary(fixture: PortabilityFixture): Promise<string> {
  const asset = await fixture.assets.put({
    bytes: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
      Buffer.from(canary),
      Buffer.from([0x00, 0xff]),
    ]),
    extension: "png",
    mime: "image/png",
    role: "illustration",
    origin: "derived",
    width: 1,
    height: 1,
  });
  fixture.store.database
    .prepare(
      `UPDATE documents SET doc = json_set(doc, '$.assetId', ?)
       WHERE collection = 'synthetic_studio_entries' AND id = ?`,
    )
    .run(asset.id, fixture.records.syntheticStudioOwnedId);
  return asset.id;
}

function startNextExport(
  fixture: PortabilityFixture,
  service: ProjectExportService,
  suffix: string,
): string {
  const project = requireProject(fixture);
  const paused = service.pause(pauseInput(project, `secret-${suffix}`));
  return service.start(startInput(paused.current.operation, `secret-${suffix}`))
    .current.operation.id;
}

function assertFailedCandidate(
  fixture: PortabilityFixture,
  operationId: string,
  priorOperationId: string,
): void {
  const failed = storedOperation(fixture, operationId);
  const prior = storedOperation(fixture, priorOperationId);
  expect(failed).toMatchObject({
    state: "failed",
    failureCode: "EXPORT_SECRET_FOUND",
    archiveKey: null,
    archiveChecksum: null,
    archiveBytes: null,
  });
  expect(prior.state).toBe("ready");
  expect(managedOperationIds(fixture)).toEqual([priorOperationId]);
}

class FinalPassSecretStore extends ManagedExportStore {
  verificationCalls = 0;

  constructor(
    root: string,
    private readonly inject: () => void,
  ) {
    super(root);
  }

  override publish(input: ManagedExportPublishInput) {
    return super.publish({
      ...input,
      verify: (candidate, archive) => {
        this.verificationCalls += 1;
        this.inject();
        return input.verify(candidate, archive);
      },
    });
  }
}

function exportService(
  fixture: PortabilityFixture,
  registry: PortabilityRegistry,
  managedStore = new ManagedExportStore(join(fixture.paths.root, "exports")),
): ProjectExportService {
  return new ProjectExportService({
    store: fixture.store,
    registry,
    assets: fixture.assets,
    originals: fixture.originals,
    scheduler: fixtureScheduler(fixture.store, ulid),
    stagingStore: new SnapshotStagingStore(
      join(fixture.paths.root, "export-staging"),
    ),
    managedStore,
    appVersion: "0.1.0-secret-test",
    nowIso: () => "2026-07-16T00:06:00.000Z",
    idFactory: ulid,
  });
}

function testRegistry(): PortabilityRegistry {
  return createPortabilityRegistry(
    [
      customerParticipant(),
      familyParticipant(),
      projectParticipant(),
      assetParticipant(),
      syntheticStudioParticipant(),
    ],
    {
      collections: [
        "assets",
        "customers",
        "families",
        "projects",
        "synthetic_studio_entries",
      ].map((key) => ({ key, owner: "participant" as const })),
      assetRoles: ["illustration", "thumbnail"].map((key) => ({
        key,
        owner: "participant" as const,
      })),
      jobTypes: [],
      scopedWriters: [],
    },
  );
}

function customerParticipant() {
  return definePortabilityParticipant({
    key: "customers",
    collection: "customers",
    currentSchemaVersion: 1,
    schema: customerSchema,
    selectForProject: (document, root) =>
      document.id === root.customerId ? "project_customer" : null,
    selectForCustomer: (document, root) =>
      document.id === root.customerId ? "customer_root" : null,
    customerIds: (document) => [document.id],
  });
}

function familyParticipant() {
  return definePortabilityParticipant({
    key: "families",
    collection: "families",
    currentSchemaVersion: 1,
    schema: familySchema,
    dependencies: ["customers"],
    selectForProject: (document, root) =>
      document.id === root.familyId ? "project_family" : null,
    selectForCustomer: (document, root) =>
      document.customerId === root.customerId ? "customer_family" : null,
    customerIds: (document) => [document.customerId],
    ownerReferences: (document) => [
      { collection: "customers", id: document.customerId, field: "customerId" },
    ],
  });
}

function projectParticipant() {
  return definePortabilityParticipant({
    key: "projects",
    collection: "projects",
    currentSchemaVersion: 2,
    schema: projectSchema,
    dependencies: ["customers", "families"],
    selectForProject: (document, root) =>
      document.id === root.projectId ? "project_root" : null,
    projectIds: (document) => [document.id],
    customerIds: (document) => [document.customerId],
    ownerReferences: (document) => [
      { collection: "customers", id: document.customerId, field: "customerId" },
      { collection: "families", id: document.familyId, field: "familyId" },
    ],
  });
}

function assetParticipant() {
  return definePortabilityParticipant({
    key: "assets",
    collection: "assets",
    currentSchemaVersion: 1,
    schema: assetRecordSchema,
    claims: { assetRoles: ["illustration", "thumbnail"] },
  });
}

function syntheticStudioParticipant() {
  return definePortabilityParticipant({
    key: "synthetic_studio_entries",
    collection: "synthetic_studio_entries",
    currentSchemaVersion: 1,
    schema: syntheticStudioFixtureSchema,
    dependencies: ["assets", "customers", "families", "projects"],
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
    ownerReferences: (document) => studioOwnerReferences(document.owner),
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
  });
}

function studioOwnerReferences(
  owner:
    | { kind: "customer"; customerId: string; familyId: string }
    | { kind: "prompt_only" },
) {
  return owner.kind === "customer"
    ? [
        {
          collection: "customers",
          id: owner.customerId,
          field: "owner.customerId",
        },
        { collection: "families", id: owner.familyId, field: "owner.familyId" },
      ]
    : [];
}

function lowLevelArchive(
  exportId: string,
  documentId = "project-clean-id",
  bytes = Buffer.from('{"notes":"synthetic clean document"}'),
) {
  const sha256 = hash(bytes);
  const manifest = createManifest({
    appVersion: "0.1.0-secret-test",
    createdAt: "2026-07-16T00:06:00.000Z",
    exportId,
    mode: "project",
    scope: {
      kind: "project",
      projectId: "project-clean-id",
      customerId: "customer-clean-id",
      familyId: "family-clean-id",
    },
    roots: [{ kind: "project", id: "project-clean-id" }],
    documents: [
      {
        collection: "projects",
        id: documentId,
        schemaVersion: 1,
        bytes: bytes.byteLength,
        sha256,
      },
    ],
    media: [],
    snapshotHash: "a".repeat(64),
  });
  return {
    manifest,
    sources: [
      {
        path: manifest.documents[0].path,
        bytes: bytes.byteLength,
        sha256,
        open: () => Readable.from(bytes),
      },
    ] satisfies StagedArchiveSource[],
  };
}

function publishLowLevel(
  store: ManagedExportStore,
  archive: ReturnType<typeof lowLevelArchive>,
) {
  const gate = new SecretReleaseGate(new SecretRegistry());
  return store.publish({
    exportId: archive.manifest.exportId,
    write: (output: Writable) =>
      writeDeterministicArchive(archive.manifest, archive.sources, output),
    verify: (path, written) =>
      verifyFinalizedArchive(path, archive.manifest, written, gate),
  });
}

function requireProject(fixture: PortabilityFixture) {
  const project = new AuthoringRepositories(fixture.store).projects.get(
    fixture.scope.projectId,
  );
  if (!project) throw new Error("bad portability fixture");
  return project;
}

function pauseInput(
  project: ReturnType<typeof requireProject>,
  suffix: string,
) {
  const request = {
    projectId: project.id,
    expectedProjectRevision: project.revision,
    idempotencyKey: `pause-${suffix}`,
    acknowledgedChildPhotos: true,
    acknowledgedNoAutomaticBackup: true,
  };
  return { ...request, requestHash: pauseProjectExportRequestHash(request) };
}

function startInput(operation: ExportOperation, suffix: string) {
  const request = {
    projectId: operation.projectId,
    operationId: operation.id,
    expectedProjectRevision: operation.projectRevision,
    expectedOperationRevision: operation.revision,
    idempotencyKey: `start-${suffix}`,
  };
  return { ...request, requestHash: startProjectExportRequestHash(request) };
}

function storedOperation(
  fixture: PortabilityFixture,
  operationId: string,
): Record<string, unknown> {
  const row = fixture.store.database
    .prepare(
      "SELECT doc FROM documents WHERE collection = 'export_operations' AND id = ?",
    )
    .get(operationId) as { doc: string } | undefined;
  if (!row) throw new Error("missing export operation");
  return JSON.parse(row.doc) as Record<string, unknown>;
}

function managedOperationIds(fixture: PortabilityFixture): string[] {
  return (
    fixture.store.database
      .prepare(
        `SELECT json_extract(doc, '$.operationId') AS operationId
         FROM documents WHERE collection = 'managed_exports'
         ORDER BY operationId`,
      )
      .all() as Array<{ operationId: string }>
  ).map((row) => row.operationId);
}

function snapshotMediaIds(
  fixture: PortabilityFixture,
  operationId: string,
): string[] {
  const operation = storedOperation(fixture, operationId);
  const snapshotId = operation.snapshotId;
  if (typeof snapshotId !== "string") throw new Error("missing snapshot id");
  return (
    fixture.store.database
      .prepare(
        `SELECT json_extract(doc, '$.mediaId') AS mediaId
         FROM documents
         WHERE collection = 'portability_snapshot_entries'
           AND json_extract(doc, '$.snapshotId') = ?
           AND json_extract(doc, '$.entryType') = 'media'
         ORDER BY mediaId`,
      )
      .all(snapshotId) as Array<{ mediaId: string }>
  ).map((row) => row.mediaId);
}

async function trackedFixture(): Promise<PortabilityFixture> {
  const fixture = await createPortabilityFixture();
  cleanups.push(fixture.cleanup);
  return fixture;
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
