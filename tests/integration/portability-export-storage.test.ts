import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { z } from "zod";

import { canonicalJson } from "../../src/contracts/canonical-json.js";
import {
  exportOperationSchema,
  managedExportSchema,
  portabilityMediaHoldSchema,
  portabilityMediaInputSchema,
  portabilitySnapshotSchema,
  type ExportOperation,
  type PortabilitySnapshot,
} from "../../src/domain/portability/export-model.js";
import {
  ExportOperationRepository,
  ManagedExportRepository,
  PortabilitySnapshotRepository,
} from "../../src/domain/portability/export-storage.js";
import {
  createPortabilityRegistry,
  definePortabilityParticipant,
  type PortabilityCatalog,
} from "../../src/domain/portability/participants.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const now = "2026-07-16T10:00:00.000Z";
const later = "2026-07-16T10:01:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("portability export models", () => {
  it("rejects paths, unknown fields, and incomplete ready/frozen states", () => {
    const ids = scopeIds();
    expect(
      exportOperationSchema.safeParse({
        ...operation(ids, "ready"),
        archiveKey: null,
      }).success,
    ).toBe(false);
    expect(
      exportOperationSchema.safeParse({
        ...operation(ids, "ready"),
        archiveKey: "/Users/operator/export.zip",
      }).success,
    ).toBe(false);
    expect(
      exportOperationSchema.safeParse({
        ...operation(ids, "waiting_pause"),
        sourcePath: "/tmp/source.zip",
      }).success,
    ).toBe(false);
    expect(
      portabilitySnapshotSchema.safeParse({
        ...snapshot(ids),
        state: "frozen",
      }).success,
    ).toBe(false);
    expect(
      managedExportSchema.safeParse({
        ...managedExport(ids, operation(ids, "ready")),
        localPath: "/tmp/export.zip",
      }).success,
    ).toBe(false);
  });

  it("accepts only exact anonymous media occurrence dispositions", () => {
    const media = mediaInput(scopeIds());
    expect(portabilityMediaInputSchema.safeParse(media).success).toBe(true);
    expect(
      portabilityMediaInputSchema.safeParse({
        ...media,
        occurrenceCount: 2,
      }).success,
    ).toBe(false);
    expect(
      portabilityMediaInputSchema.safeParse({
        ...media,
        outsideScopeOccurrenceCount: 1,
      }).success,
    ).toBe(false);
    expect(
      portabilityMediaInputSchema.safeParse({
        ...media,
        ownedCount: 0,
        referencedCount: 1,
        outsideScopeOccurrenceCount: 3,
        disposition: "shared_reference_preserved",
      }).success,
    ).toBe(true);
  });

  it("rejects every inconsistent operation, snapshot, hold, and ready-record branch", () => {
    const ids = scopeIds();
    const archiveKey = `${ids.exportId}-${hash("archive")}.zip`;
    const invalidOperations = [
      { ...operation(ids, "waiting_pause"), snapshotId: ids.snapshotId },
      operation(ids, "freezing_snapshot"),
      {
        ...operation(ids, "freezing_snapshot"),
        snapshotId: ids.snapshotId,
        snapshotHash: hash("premature"),
      },
      { ...operation(ids, "packaging"), snapshotHash: null },
      { ...operation(ids, "staging"), manifestHash: hash("premature") },
      {
        ...operation(ids, "staging"),
        manifestHash: null,
        archiveKey,
        archiveChecksum: hash("archive"),
        archiveBytes: 12,
      },
      { ...operation(ids, "stale"), archiveKey },
      { ...operation(ids, "waiting_pause"), failureCode: "FAILED" },
      { ...operation(ids, "waiting_pause"), cleanupState: "pending" as const },
    ];
    for (const candidate of invalidOperations)
      expect(exportOperationSchema.safeParse(candidate).success).toBe(false);

    expect(
      portabilitySnapshotSchema.safeParse({
        ...snapshot(ids),
        documentCount: 1,
      }).success,
    ).toBe(false);
    expect(
      portabilitySnapshotSchema.safeParse({
        ...snapshot(ids),
        state: "failed",
      }).success,
    ).toBe(false);

    const media = mediaInput(ids);
    expect(
      portabilityMediaHoldSchema.safeParse({
        id: ulid(),
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        snapshotId: ids.snapshotId,
        operationId: ids.operationId,
        ...media,
        state: "held",
        releasedAt: later,
      }).success,
    ).toBe(false);

    const ready = operation(ids, "ready");
    const managed = managedExport(ids, ready);
    for (const candidate of [
      { ...managed, id: ulid() },
      { ...managed, updatedAt: now },
      { ...managed, archiveKey: `${ids.exportId}-${hash("wrong")}.zip` },
    ])
      expect(managedExportSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("portability snapshot persistence", () => {
  it("freezes canonical documents, media metadata, and exact idempotent holds", async () => {
    const fixture = await exportFixture();
    const ids = scopeIds();
    const initial = snapshot(ids);
    const customer = customerDocument(ids);
    const project = projectDocument(ids);
    const media = mediaInput(ids);

    const frozen = fixture.store.transactionImmediate(() => {
      fixture.snapshots.createInTransaction(initial);
      fixture.snapshots.appendDocumentInTransaction(initial.id, {
        collection: "customers",
        document: customer,
        reasons: ["direct:project", "edge:project#customerId"],
      });
      fixture.snapshots.appendDocumentInTransaction(initial.id, {
        collection: "projects",
        document: project,
        reasons: ["direct:project"],
      });
      const entry = fixture.snapshots.appendMediaInTransaction(
        initial.id,
        media,
      );
      const repeated = fixture.snapshots.ensureMediaHoldInTransaction(
        initial.id,
        media,
      );
      expect(repeated.mediaId).toBe(entry.mediaId);
      return fixture.snapshots.freezeInTransaction(initial.id);
    });

    const entries = fixture.snapshots.entries(initial.id);
    expect(entries.map((entry) => entry.ordinal)).toEqual([0, 1, 2]);
    expect(entries.map((entry) => entry.archiveEntry)).toEqual([
      `data/customers/${ids.customerId}.json`,
      `data/projects/${ids.projectId}.json`,
      `media/assets/${media.sha256}.${media.extension}`,
    ]);
    const customerEntry = entries[0];
    expect(customerEntry?.entryType).toBe("document");
    if (customerEntry?.entryType !== "document") throw new Error("bad fixture");
    expect(customerEntry.canonicalDocument).toBe(canonicalJson(customer));
    expect(customerEntry.bytes).toBe(
      Buffer.byteLength(canonicalJson(customer), "utf8"),
    );
    expect(customerEntry.sha256).toBe(hash(canonicalJson(customer)));
    expect(fixture.snapshots.holds(initial.id)).toHaveLength(1);
    expect(frozen).toMatchObject({
      state: "frozen",
      documentCount: 2,
      mediaCount: 1,
      nextOrdinal: 3,
      participantRegistryHash: fixture.registry.hash,
    });
    expect(frozen.totalUncompressedBytes).toBe(
      entries.reduce((total, entry) => total + entry.bytes, 0),
    );
    expect(frozen.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      fixture.snapshots.appendDocumentInTransaction(initial.id, {
        collection: "projects",
        document: project,
        reasons: ["late"],
      }),
    ).toThrow("PORTABILITY_TRANSACTION_REQUIRED");
    expect(() => fixture.snapshots.freezeInTransaction(initial.id)).toThrow(
      "PORTABILITY_TRANSACTION_REQUIRED",
    );
  });

  it("derives the same snapshot hash after restart and across operation ids", async () => {
    const fixture = await exportFixture();
    const ids = scopeIds();
    const first = freezeFixture(fixture, snapshot(ids), ids);
    const secondSnapshot = snapshot({
      ...ids,
      snapshotId: ulid(),
      operationId: ulid(),
    });
    const second = freezeFixture(fixture, secondSnapshot, ids);
    expect(second.snapshotHash).toBe(first.snapshotHash);

    fixture.store.close();
    const reopened = new DocumentStore(fixture.database);
    try {
      const snapshots = new PortabilitySnapshotRepository(
        reopened,
        fixture.registry,
      );
      expect(snapshots.get(first.id)).toEqual(first);
      expect(snapshots.entries(first.id)).toHaveLength(3);
      expect(snapshots.holds(first.id)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it("binds anonymous media occurrence facts into hold linkage and snapshot hashes", async () => {
    const fixture = await exportFixture();
    const ids = scopeIds();
    const frozen = freezeFixture(fixture, snapshot(ids), ids);
    const hold = fixture.snapshots.holds(frozen.id)[0];

    rewriteMediaLedger(fixture.store, "portability_media_holds", hold.id);
    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.snapshots.freezeInTransaction(frozen.id),
      ),
    ).toThrow("PORTABILITY_MEDIA_HOLD_INCOMPLETE");

    const entry = fixture.snapshots
      .entries(frozen.id)
      .find((candidate) => candidate.entryType === "media");
    if (!entry) throw new Error("bad fixture");
    rewriteMediaLedger(fixture.store, "portability_snapshot_entries", entry.id);
    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.snapshots.freezeInTransaction(frozen.id),
      ),
    ).toThrow("PORTABILITY_SNAPSHOT_HASH_MISMATCH");
  });

  it("rolls back gaps/order errors and refuses freeze with a missing hold", async () => {
    const fixture = await exportFixture();
    const ids = scopeIds();
    const initial = snapshot(ids);
    expect(() =>
      fixture.store.transactionImmediate(() => {
        fixture.snapshots.createInTransaction(initial);
        fixture.snapshots.appendDocumentInTransaction(initial.id, {
          collection: "projects",
          document: projectDocument(ids),
          reasons: ["direct"],
        });
        fixture.snapshots.appendDocumentInTransaction(initial.id, {
          collection: "customers",
          document: customerDocument(ids),
          reasons: ["edge"],
        });
      }),
    ).toThrow("PORTABILITY_SNAPSHOT_ENTRY_ORDER_INVALID");
    expect(fixture.snapshots.get(initial.id)).toBeNull();

    fixture.store.transactionImmediate(() => {
      fixture.snapshots.createInTransaction(initial);
      fixture.snapshots.appendDocumentInTransaction(initial.id, {
        collection: "customers",
        document: customerDocument(ids),
        reasons: ["direct"],
      });
      fixture.snapshots.appendMediaInTransaction(initial.id, mediaInput(ids));
    });
    const hold = fixture.snapshots.holds(initial.id)[0];
    expect(() =>
      fixture.store.transactionImmediate(() => {
        fixture.store.database
          .prepare("DELETE FROM documents WHERE collection = ? AND id = ?")
          .run("portability_media_holds", hold.id);
        fixture.snapshots.freezeInTransaction(initial.id);
      }),
    ).toThrow("PORTABILITY_MEDIA_HOLD_INCOMPLETE");
    expect(fixture.snapshots.holds(initial.id)).toEqual([hold]);
    expect(fixture.snapshots.get(initial.id)?.state).toBe("freezing");
  });

  it("detects canonical document row tampering before use", async () => {
    const fixture = await exportFixture();
    const ids = scopeIds();
    const initial = snapshot(ids);
    fixture.store.transactionImmediate(() => {
      fixture.snapshots.createInTransaction(initial);
      fixture.snapshots.appendDocumentInTransaction(initial.id, {
        collection: "customers",
        document: customerDocument(ids),
        reasons: ["direct"],
      });
    });
    const row = fixture.snapshots.entries(initial.id)[0];
    fixture.store.database
      .prepare(
        `UPDATE documents SET doc = json_set(doc, '$.sha256', ?)
         WHERE collection = ? AND id = ?`,
      )
      .run(hash("tampered"), "portability_snapshot_entries", row.id);
    expect(() => fixture.snapshots.entries(initial.id)).toThrow(
      "PORTABILITY_SNAPSHOT_DOCUMENT_HASH_MISMATCH",
    );
  });

  it("CAS-transitions lifecycle and releases each hold once in the same transaction", async () => {
    const fixture = await exportFixture();
    const ids = scopeIds();
    const frozen = freezeFixture(fixture, snapshot(ids), ids);
    const staging = nextSnapshot(frozen, "staging");
    expect(() =>
      fixture.snapshots.transitionInTransaction(frozen, staging),
    ).toThrow("PORTABILITY_TRANSACTION_REQUIRED");
    fixture.store.transactionImmediate(() =>
      fixture.snapshots.transitionInTransaction(frozen, staging),
    );

    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.snapshots.releaseMediaHoldsInTransaction(staging.id, () =>
          Promise.resolve(),
        ),
      ),
    ).toThrow("ASYNC_TRANSACTION_FORBIDDEN");
    expect(fixture.snapshots.holds(staging.id)[0].state).toBe("held");
    const staged = nextSnapshot(staging, "staged");
    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.snapshots.transitionInTransaction(staging, staged),
      ),
    ).toThrow("PORTABILITY_MEDIA_HOLD_INCOMPLETE");

    const releasedIds: string[] = [];
    fixture.store.transactionImmediate(() => {
      fixture.snapshots.releaseMediaHoldsInTransaction(staging.id, (hold) => {
        expect(fixture.store.database.inTransaction).toBe(true);
        releasedIds.push(hold.mediaId);
      });
      fixture.snapshots.releaseMediaHoldsInTransaction(staging.id, () => {
        throw new Error("release callback replayed");
      });
      fixture.snapshots.transitionInTransaction(staging, staged);
    });
    expect(releasedIds).toEqual([ids.mediaId]);
    expect(fixture.snapshots.holds(staging.id)[0].state).toBe("released");

    const released = nextSnapshot(staged, "released");
    fixture.store.transactionImmediate(() =>
      fixture.snapshots.transitionInTransaction(staged, released),
    );
    expect(fixture.snapshots.get(staging.id)?.state).toBe("released");
    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.snapshots.transitionInTransaction(staging, released),
      ),
    ).toThrow("PORTABILITY_SNAPSHOT_CONFLICT");
  });
});

describe("export operation and managed export persistence", () => {
  it("enforces ordered state transitions and immutable scope ownership", async () => {
    const fixture = await exportFixture();
    const ids = scopeIds();
    const waiting = operation(ids, "waiting_pause");
    fixture.store.transactionImmediate(() =>
      fixture.operations.insertInTransaction(waiting),
    );
    const readyTooEarly = operation(ids, "ready", {
      id: waiting.id,
      createdAt: waiting.createdAt,
      revision: 1,
      updatedAt: later,
    });
    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.operations.updateInTransaction(waiting, readyTooEarly),
      ),
    ).toThrow("PORTABILITY_EXPORT_STATE_TRANSITION_INVALID");

    const next = operation(ids, "waiting_quiescence", {
      id: waiting.id,
      createdAt: waiting.createdAt,
      revision: 1,
      updatedAt: later,
    });
    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.operations.updateInTransaction(waiting, {
          ...next,
          customerId: ulid(),
        }),
      ),
    ).toThrow("PORTABILITY_EXPORT_IMMUTABLE_FIELD_CHANGED");
    expect(
      fixture.store.transactionImmediate(() =>
        fixture.operations.updateInTransaction(waiting, next),
      ),
    ).toEqual(next);
  });

  it("uses CAS/idempotency and records only an exactly matched ready export", async () => {
    const fixture = await exportFixture();
    const ids = scopeIds();
    const scanning = operation(ids, "secret_scanning");
    fixture.store.transactionImmediate(() =>
      fixture.operations.insertInTransaction(scanning),
    );
    expect(
      fixture.operations.find(ids.projectId, scanning.idempotencyKey),
    ).toEqual(scanning);

    const ready = operation(ids, "ready", {
      id: scanning.id,
      createdAt: scanning.createdAt,
      revision: scanning.revision + 1,
      updatedAt: later,
    });
    const managed = managedExport(ids, ready);
    fixture.store.transactionImmediate(() => {
      fixture.operations.updateInTransaction(scanning, ready);
      expect(fixture.managed.recordReadyInTransaction(ready, managed)).toEqual(
        managed,
      );
      expect(fixture.managed.recordReadyInTransaction(ready, managed)).toEqual(
        managed,
      );
    });
    expect(fixture.managed.forOperation(ready.id)).toEqual(managed);

    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.managed.recordReadyInTransaction(ready, {
          ...managed,
          bytes: managed.bytes + 1,
        }),
      ),
    ).toThrow("PORTABILITY_MANAGED_EXPORT_MISMATCH");
    expect(fixture.managed.forOperation(ready.id)).toEqual(managed);
    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.operations.insertInTransaction({
          ...scanning,
          id: ulid(),
          requestHash: hash("collision"),
        }),
      ),
    ).toThrow("PORTABILITY_EXPORT_IDEMPOTENCY_COLLISION");
  });
});

function freezeFixture(
  fixture: Awaited<ReturnType<typeof exportFixture>>,
  initial: PortabilitySnapshot,
  ids: ReturnType<typeof scopeIds>,
) {
  return fixture.store.transactionImmediate(() => {
    fixture.snapshots.createInTransaction(initial);
    fixture.snapshots.appendDocumentInTransaction(initial.id, {
      collection: "customers",
      document: customerDocument(ids),
      reasons: ["direct"],
    });
    fixture.snapshots.appendDocumentInTransaction(initial.id, {
      collection: "projects",
      document: projectDocument(ids),
      reasons: ["direct"],
    });
    fixture.snapshots.appendMediaInTransaction(initial.id, mediaInput(ids));
    return fixture.snapshots.freezeInTransaction(initial.id);
  });
}

function nextSnapshot(
  current: PortabilitySnapshot,
  state: PortabilitySnapshot["state"],
): PortabilitySnapshot {
  return {
    ...current,
    revision: current.revision + 1,
    updatedAt: later,
    state,
    failureCode: state === "failed" ? "SNAPSHOT_FAILED" : null,
  };
}

async function exportFixture() {
  const directory = await temporaryDirectory("hekayati-export-storage-");
  const database = join(directory.path, "export.db");
  const store = new DocumentStore(database);
  const registry = testRegistry();
  const options = { nowIso: () => later, idFactory: ulid };
  const snapshots = new PortabilitySnapshotRepository(store, registry, options);
  const operations = new ExportOperationRepository(store);
  const managed = new ManagedExportRepository(store);
  cleanups.push(async () => {
    if (store.database.open) store.close();
    await directory.cleanup();
  });
  return { database, store, registry, snapshots, operations, managed };
}

function testRegistry() {
  const base = {
    id: z.string(),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  };
  const customerSchema = z.object({ ...base, name: z.string() }).strict();
  const projectSchema = z
    .object({
      ...base,
      customerId: z.string(),
      familyId: z.string(),
      title: z.string(),
    })
    .strict();
  const assetSchema = z
    .object({ ...base, role: z.literal("illustration") })
    .strict();
  const catalog: PortabilityCatalog = {
    collections: ["assets", "customers", "projects"].map((key) => ({
      key,
      owner: "participant",
    })),
    assetRoles: [{ key: "illustration", owner: "participant" }],
    jobTypes: [],
    scopedWriters: [],
  };
  return createPortabilityRegistry(
    [
      definePortabilityParticipant({
        key: "assets",
        collection: "assets",
        currentSchemaVersion: 1,
        schema: assetSchema,
        claims: { assetRoles: ["illustration"] },
      }),
      definePortabilityParticipant({
        key: "customers",
        collection: "customers",
        currentSchemaVersion: 1,
        schema: customerSchema,
      }),
      definePortabilityParticipant({
        key: "projects",
        collection: "projects",
        currentSchemaVersion: 1,
        schema: projectSchema,
        dependencies: ["customers"],
      }),
    ],
    catalog,
  );
}

function scopeIds() {
  return {
    snapshotId: ulid(),
    operationId: ulid(),
    exportId: ulid(),
    projectId: ulid(),
    customerId: ulid(),
    familyId: ulid(),
    mediaId: ulid(),
  };
}

function snapshot(ids: ReturnType<typeof scopeIds>): PortabilitySnapshot {
  return {
    id: ids.snapshotId,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    operationId: ids.operationId,
    projectId: ids.projectId,
    customerId: ids.customerId,
    familyId: ids.familyId,
    projectRevision: 4,
    participantRegistryHash: testRegistry().hash,
    state: "freezing",
    documentCount: 0,
    mediaCount: 0,
    totalUncompressedBytes: 0,
    documentRootHash: null,
    mediaRootHash: null,
    snapshotHash: null,
    nextOrdinal: 0,
    failureCode: null,
  };
}

function operation(
  ids: ReturnType<typeof scopeIds>,
  state: ExportOperation["state"],
  override: Partial<ExportOperation> = {},
): ExportOperation {
  const postSnapshot = ![
    "waiting_pause",
    "waiting_quiescence",
    "acquiring_lock",
    "freezing_snapshot",
  ].includes(state);
  const ready = state === "ready";
  return {
    id: ids.operationId,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    projectId: ids.projectId,
    customerId: ids.customerId,
    familyId: ids.familyId,
    idempotencyKey: "export-key",
    requestHash: hash("request"),
    projectRevision: 4,
    state,
    snapshotId: postSnapshot ? ids.snapshotId : null,
    snapshotHash: postSnapshot ? hash("snapshot") : null,
    documentCount: postSnapshot ? 2 : 0,
    mediaCount: postSnapshot ? 1 : 0,
    totalUncompressedBytes: postSnapshot ? 1_024 : 0,
    manifestHash: postSnapshot ? hash("manifest") : null,
    archiveKey: ready ? `${ids.exportId}-${hash("archive")}.zip` : null,
    archiveChecksum: ready ? hash("archive") : null,
    archiveBytes: ready ? 512 : null,
    failureCode:
      state === "failed" || state === "stale" ? "EXPORT_FAILED" : null,
    cleanupState: state === "failed" ? "pending" : "none",
    ...override,
  };
}

function managedExport(
  ids: ReturnType<typeof scopeIds>,
  ready: ExportOperation,
) {
  return {
    id: ids.exportId,
    schemaVersion: 1 as const,
    createdAt: later,
    updatedAt: later,
    exportId: ids.exportId,
    operationId: ready.id,
    projectId: ids.projectId,
    customerId: ids.customerId,
    familyId: ids.familyId,
    archiveKey: ready.archiveKey!,
    manifestVersion: 2 as const,
    snapshotHash: ready.snapshotHash!,
    manifestHash: ready.manifestHash!,
    archiveChecksum: ready.archiveChecksum!,
    bytes: ready.archiveBytes!,
    secretScan: {
      passed: true as const,
      candidateScanPassed: true as const,
      finalizedArchiveScanPassed: true as const,
      scannedAt: later,
    },
  };
}

function customerDocument(ids: ReturnType<typeof scopeIds>) {
  return {
    id: ids.customerId,
    schemaVersion: 1 as const,
    createdAt: now,
    updatedAt: now,
    name: "Synthetic customer",
  };
}

function projectDocument(ids: ReturnType<typeof scopeIds>) {
  return {
    id: ids.projectId,
    schemaVersion: 1 as const,
    createdAt: now,
    updatedAt: now,
    customerId: ids.customerId,
    familyId: ids.familyId,
    title: "Synthetic project",
  };
}

function mediaInput(ids: ReturnType<typeof scopeIds>) {
  return {
    namespace: "asset" as const,
    mediaId: ids.mediaId,
    role: "illustration",
    mime: "image/png",
    extension: "png",
    bytes: 64,
    sha256: hash("media"),
    occurrenceCount: 1,
    ownedCount: 1,
    referencedCount: 0,
    outsideScopeOccurrenceCount: 0,
    preHoldRefCount: 1,
    disposition: "scope_only" as const,
  };
}

function rewriteMediaLedger(
  store: DocumentStore,
  collection: string,
  id: string,
): void {
  store.database
    .prepare(
      `UPDATE documents
       SET doc = json_set(
         doc,
         '$.ownedCount', 0,
         '$.referencedCount', 1,
         '$.outsideScopeOccurrenceCount', 1,
         '$.disposition', 'shared_reference_preserved'
       )
       WHERE collection = ? AND id = ?`,
    )
    .run(collection, id);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
