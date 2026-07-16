import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ulid } from "ulid";

import {
  ExportOperationRepository,
  ManagedExportRepository,
} from "../../src/domain/portability/export-storage.js";
import {
  REAL_PORTABILITY_CATALOG,
  createPortabilityRegistry,
  definePortabilityParticipant,
  extendPortabilityCatalog,
} from "../../src/domain/portability/participants.js";
import { realPortabilityParticipants } from "../../src/domain/portability/real-participants.js";
import { selectDeletionGraph } from "../../src/domain/portability/deletion-graph.js";
import { DeletionService } from "../../src/domain/portability/deletion-service.js";
import {
  ManagedDeletionCleanup,
  type ManagedDeletionCleanupHooks,
} from "../../src/portability/deletion-cleanup.js";
import {
  createPortabilityFixture,
  portabilityFixtureAt,
  syntheticStudioFixtureSchema,
  type PortabilityFixture,
} from "./portability-fixture.js";

export interface DeletionHarness {
  fixture: PortabilityFixture;
  managedExportsRoot: string;
  makeService(input?: {
    cleanupHooks?: ManagedDeletionCleanupHooks;
    serviceHooks?: ConstructorParameters<typeof DeletionService>[0]["hooks"];
  }): DeletionService;
}

export async function createDeletionHarness(): Promise<DeletionHarness> {
  const fixture = await createPortabilityFixture();
  const managedExportsRoot = join(fixture.paths.root, "exports");
  const registry = deletionTestRegistry();
  normalizeFixtureRefCounts(fixture, registry);
  return {
    fixture,
    managedExportsRoot,
    makeService(input = {}) {
      const cleanup = new ManagedDeletionCleanup({
        store: fixture.store,
        assets: fixture.assets,
        originals: fixture.originals,
        managedExportsRoot,
        hooks: input.cleanupHooks,
      });
      return new DeletionService({
        store: fixture.store,
        registry,
        assets: fixture.assets,
        originals: fixture.originals,
        cleanup,
        nowIso: () => portabilityFixtureAt,
        hooks: input.serviceHooks,
      });
    },
  };
}

function normalizeFixtureRefCounts(
  fixture: PortabilityFixture,
  registry: ReturnType<typeof deletionTestRegistry>,
): void {
  const graph = selectDeletionGraph({
    store: fixture.store,
    registry,
    target: { kind: "customer", id: fixture.scope.customerId },
  });
  for (const media of graph.media) {
    const record =
      media.namespace === "asset"
        ? fixture.assets.get(media.mediaId)
        : fixture.originals.get(media.mediaId);
    if (!record) continue;
    for (let count = record.refCount; count < media.ownedRefs; count += 1) {
      if (media.namespace === "asset") fixture.assets.retain(media.mediaId);
      else fixture.originals.retain(media.mediaId);
    }
  }
}

export function deletionTestRegistry() {
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

export async function seedManagedExport(
  harness: DeletionHarness,
): Promise<{ id: string; path: string; bytes: Buffer }> {
  const { fixture, managedExportsRoot } = harness;
  const id = ulid();
  const operationId = ulid();
  const snapshotId = ulid();
  const bytes = Buffer.from("synthetic-managed-export");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const archiveKey = `${id}-${checksum}.zip`;
  const path = join(managedExportsRoot, archiveKey);
  const operation = {
    id: operationId,
    schemaVersion: 1 as const,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    revision: 0,
    projectId: fixture.scope.projectId,
    customerId: fixture.scope.customerId,
    familyId: fixture.scope.familyId,
    idempotencyKey: "deletion-fixture-export",
    requestHash: hash("request"),
    projectRevision: 0,
    state: "ready" as const,
    snapshotId,
    snapshotHash: hash("snapshot"),
    documentCount: 1,
    mediaCount: 0,
    totalUncompressedBytes: bytes.length,
    manifestHash: hash("manifest"),
    archiveKey,
    archiveChecksum: checksum,
    archiveBytes: bytes.length,
    failureCode: null,
    cleanupState: "none" as const,
  };
  const record = {
    id,
    schemaVersion: 1 as const,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    exportId: id,
    operationId,
    projectId: fixture.scope.projectId,
    customerId: fixture.scope.customerId,
    familyId: fixture.scope.familyId,
    archiveKey,
    manifestVersion: 2 as const,
    snapshotHash: operation.snapshotHash,
    manifestHash: operation.manifestHash,
    archiveChecksum: checksum,
    bytes: bytes.length,
    secretScan: {
      passed: true as const,
      candidateScanPassed: true as const,
      finalizedArchiveScanPassed: true as const,
      scannedAt: portabilityFixtureAt,
    },
  };
  fixture.store.transactionImmediate(() => {
    const operations = new ExportOperationRepository(fixture.store);
    const exports = new ManagedExportRepository(fixture.store);
    operations.insertInTransaction(operation);
    exports.recordReadyInTransaction(operation, record);
  });
  await mkdir(managedExportsRoot, { recursive: true, mode: 0o700 });
  await chmod(managedExportsRoot, 0o700);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
  return { id, path, bytes };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
