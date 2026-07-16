import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { ImportOperationRepository } from "../../src/domain/portability/import-storage.js";
import { ImportUploadService } from "../../src/domain/portability/import-upload.js";
import { PortabilityActionRepository } from "../../src/domain/portability/repositories.js";
import { ManagedImportStore } from "../../src/portability/import.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-16T12:00:00.000Z";
const installationId = "01K00000000000000000000000";
const ids = {
  operation: "01K00000000000000000000001",
  reservation: "01K00000000000000000000002",
  action: "01K00000000000000000000003",
  operation2: "01K00000000000000000000004",
  reservation2: "01K00000000000000000000005",
  action2: "01K00000000000000000000006",
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("import upload FR-160 boundary", () => {
  it("verifies the first stream then atomically adopts operation and action", async () => {
    const fixture = await harness([ids.operation, ids.reservation, ids.action]);
    const source = Buffer.from("synthetic-external-archive");
    let opens = 0;
    const request = uploadRequest(source, "upload-key", () => {
      opens += 1;
    });

    const first = await fixture.service.upload(request);
    expect(first.replayed).toBe(false);
    expect(first.current).toMatchObject({
      id: ids.operation,
      state: "uploaded",
      reservationKey: `${ids.reservation}.zip`,
      sourceArchiveHash: sha256(source),
      sourceArchiveBytes: source.byteLength,
      actionRefs: { uploadActionId: ids.action },
    });
    expect(first.action.id).toBe(ids.action);
    expect(opens).toBe(1);
    const reserved = join(
      fixture.root,
      "reservations",
      `${ids.reservation}.zip`,
    );
    expect(await readFile(reserved)).toEqual(source);
    expect((await stat(reserved)).mode & 0o777).toBe(0o600);
    expect((await stat(fixture.root)).mode & 0o777).toBe(0o700);
    expect(fixture.actions.list()).toHaveLength(1);
    expect(fixture.operations.list()).toHaveLength(1);

    const replay = await fixture.service.upload(request);
    expect(replay.replayed).toBe(true);
    expect(replay.action).toEqual(first.action);
    expect(replay.current).toEqual(first.current);
    expect(opens).toBe(1);
  });

  it("rejects key/hash collisions before consuming another body", async () => {
    const fixture = await harness([ids.operation, ids.reservation, ids.action]);
    await fixture.service.upload(
      uploadRequest(Buffer.from("first-archive"), "same-key"),
    );
    let opened = false;
    await expect(
      fixture.service.upload(
        uploadRequest(Buffer.from("different-archive"), "same-key", () => {
          opened = true;
        }),
      ),
    ).rejects.toThrow("PORTABILITY_ACTION_IDEMPOTENCY_COLLISION");
    expect(opened).toBe(false);
    expect(fixture.actions.list()).toHaveLength(1);
    expect(fixture.operations.list()).toHaveLength(1);
  });

  it("cleans a checksum/byte mismatch with zero durable action or operation", async () => {
    const fixture = await harness([
      ids.operation,
      ids.reservation,
      ids.action,
      ids.operation2,
      ids.reservation2,
      ids.action2,
    ]);
    const bytes = Buffer.from("synthetic-archive");
    await expect(
      fixture.service.upload({
        ...uploadRequest(bytes, "bad-hash"),
        declaredArchiveHash: "f".repeat(64),
      }),
    ).rejects.toThrow("IMPORT_UPLOAD_CHECKSUM_MISMATCH");
    await expect(
      fixture.service.upload({
        ...uploadRequest(bytes, "bad-bytes"),
        declaredArchiveBytes: bytes.byteLength - 1,
      }),
    ).rejects.toThrow("IMPORT_UPLOAD_BYTES_MISMATCH");
    expect(fixture.actions.list()).toHaveLength(0);
    expect(fixture.operations.list()).toHaveLength(0);
    expect(await readdir(join(fixture.root, "reservations"))).toEqual([]);
  });

  it("never overwrites an existing reservation key", async () => {
    const fixture = await harness([ids.operation, ids.reservation, ids.action]);
    await fixture.managed.initialize();
    const target = join(fixture.root, "reservations", `${ids.reservation}.zip`);
    const prior = Buffer.from("prior-private-reservation");
    await writeFile(target, prior, { mode: 0o600, flag: "wx" });

    await expect(
      fixture.service.upload(
        uploadRequest(Buffer.from("new-reservation"), "collision"),
      ),
    ).rejects.toThrow("IMPORT_RESERVATION_KEY_CONFLICT");
    expect(await readFile(target)).toEqual(prior);
    expect(fixture.actions.list()).toHaveLength(0);
    expect(fixture.operations.list()).toHaveLength(0);
  });

  it("never mutates or deletes the operator's external source file", async () => {
    const fixture = await harness([ids.operation, ids.reservation, ids.action]);
    const source = Buffer.from("synthetic-external-source");
    const external = join(fixture.workspace, "operator-source.zip");
    await writeFile(external, source, { mode: 0o600, flag: "wx" });
    await expect(
      fixture.service.upload({
        idempotencyKey: "external-source",
        declaredArchiveHash: "f".repeat(64),
        declaredArchiveBytes: source.byteLength,
        openSource: () => createReadStream(external),
      }),
    ).rejects.toThrow("IMPORT_UPLOAD_CHECKSUM_MISMATCH");
    expect(await readFile(external)).toEqual(source);
    expect((await stat(external)).mode & 0o777).toBe(0o600);
    expect(fixture.actions.list()).toHaveLength(0);
    expect(fixture.operations.list()).toHaveLength(0);
  });

  it("keeps one operation under a concurrent exact replay race", async () => {
    const fixture = await harness([
      ids.operation,
      ids.reservation,
      ids.operation2,
      ids.reservation2,
      ids.action,
    ]);
    const bytes = Buffer.from("same-concurrent-archive");
    const [left, right] = await Promise.all([
      fixture.service.upload(uploadRequest(bytes, "race-key")),
      fixture.service.upload(uploadRequest(bytes, "race-key")),
    ]);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(left.action.id).toBe(right.action.id);
    expect(left.current.id).toBe(right.current.id);
    expect(fixture.actions.list()).toHaveLength(1);
    expect(fixture.operations.list()).toHaveLength(1);
    expect(await readdir(join(fixture.root, "reservations"))).toHaveLength(1);
  });

  it("persists one stable installation scope across repository instances", async () => {
    const fixture = await harness([]);
    expect(fixture.operations.installationId()).toBe(installationId);
    const second = new ImportOperationRepository(fixture.db, () => {
      throw new Error("INSTALLATION_ID_MUST_NOT_REGENERATE");
    });
    expect(second.installationId()).toBe(installationId);
  });
});

describe("managed import startup reconciliation", () => {
  it("removes only recognized unowned reservations/staging", async () => {
    const directory = await temporaryDirectory("hekayati-import-reconcile-");
    cleanups.push(directory.cleanup);
    const managed = new ManagedImportStore(join(directory.path, "imports"));
    const owned = `${ids.reservation}.zip`;
    const orphan = `${ids.reservation2}.zip`;
    const payload = Buffer.from("synthetic-reservation");
    await managed.capture({
      key: owned,
      declaration: { bytes: payload.byteLength, sha256: sha256(payload) },
      openSource: () => Readable.from(payload),
    });
    await managed.capture({
      key: orphan,
      declaration: { bytes: payload.byteLength, sha256: sha256(payload) },
      openSource: () => Readable.from(payload),
    });
    await writeFile(join(managed.root, "reservations", "unknown.txt"), "keep", {
      mode: 0o600,
    });
    await writeFile(
      join(
        managed.root,
        "reservations",
        ".incoming-00000000-0000-4000-8000-000000000000.tmp",
      ),
      "orphan",
      { mode: 0o600 },
    );
    await mkdir(join(managed.stagingRoot, ids.operation), { mode: 0o700 });
    await mkdir(join(managed.stagingRoot, ids.operation2), { mode: 0o700 });
    await mkdir(join(managed.stagingRoot, "unknown-directory"), {
      mode: 0o700,
    });

    const result = await managed.reconcile({
      referencedReservations: new Set([owned]),
      referencedStaging: new Set([ids.operation]),
    });
    expect(result).toEqual({
      removedReservations: 2,
      removedStagingDirectories: 1,
    });
    expect(await readdir(join(managed.root, "reservations"))).toEqual([
      owned,
      "unknown.txt",
    ]);
    expect(await readdir(managed.stagingRoot)).toEqual([
      ids.operation,
      "unknown-directory",
    ]);
  });

  it("fails closed on invalid declarations and synchronous source errors", async () => {
    const managed = await managedImportFixture();
    const payload = Buffer.from("synthetic-managed-reservation");
    const declaration = { bytes: payload.byteLength, sha256: sha256(payload) };
    await expect(
      managed.capture({
        key: "invalid.zip",
        declaration,
        openSource: () => Readable.from(payload),
      }),
    ).rejects.toThrow("IMPORT_RESERVATION_KEY_INVALID");
    await expect(
      managed.capture({
        key: `${ids.reservation}.zip`,
        declaration: { ...declaration, sha256: "INVALID" },
        openSource: () => Readable.from(payload),
      }),
    ).rejects.toThrow("IMPORT_UPLOAD_CHECKSUM_INVALID");
    await expect(
      managed.capture({
        key: `${ids.reservation}.zip`,
        declaration,
        openSource: () => {
          throw new Error("SYNTHETIC_SOURCE_OPEN_FAILED");
        },
      }),
    ).rejects.toThrow("SYNTHETIC_SOURCE_OPEN_FAILED");
    expect(await readdir(join(managed.root, "reservations"))).toEqual([]);
  });

  it("detects reservation tampering and invalid cleanup keys", async () => {
    const managed = await managedImportFixture();
    const payload = Buffer.from("synthetic-managed-reservation");
    const declaration = { bytes: payload.byteLength, sha256: sha256(payload) };
    await managed.capture({
      key: `${ids.reservation}.zip`,
      declaration,
      openSource: () => Readable.from(payload),
    });
    await expect(
      managed.verifyReservation(`${ids.reservation}.zip`, {
        ...declaration,
        bytes: payload.byteLength - 1,
      }),
    ).rejects.toThrow("IMPORT_RESERVATION_BYTES_MISMATCH");
    await expect(
      managed.verifyReservation(`${ids.reservation}.zip`, {
        ...declaration,
        sha256: "f".repeat(64),
      }),
    ).rejects.toThrow("IMPORT_RESERVATION_INTEGRITY_MISMATCH");
    const target = managed.reservationPath(`${ids.reservation}.zip`);
    await chmod(target, 0o644);
    await expect(
      managed.openReservation(`${ids.reservation}.zip`),
    ).rejects.toThrow("IMPORT_RESERVATION_IDENTITY_INVALID");
    await chmod(target, 0o600);
    await managed.removeReservation(`${ids.reservation}.zip`);
    await managed.removeReservation(`${ids.reservation}.zip`);
    await expect(managed.removeStaging("invalid")).rejects.toThrow(
      "IMPORT_STAGING_KEY_INVALID",
    );
  });
});

describe("ImportOperation repository boundaries", () => {
  it("requires transactions, exact initial state, and revision CAS", async () => {
    const fixture = await harness([ids.operation, ids.reservation, ids.action]);
    const current = (
      await fixture.service.upload(
        uploadRequest(Buffer.from("repository-archive"), "repository-upload"),
      )
    ).current;
    expect(fixture.operations.get("01K99999999999999999999999")).toBeNull();
    expect(() => fixture.operations.insertInTransaction(current)).toThrow(
      "IMPORT_TRANSACTION_REQUIRED",
    );
    expect(() =>
      fixture.db.transactionImmediate(() =>
        fixture.operations.insertInTransaction({ ...current, revision: 1 }),
      ),
    ).toThrow("IMPORT_OPERATION_INITIAL_STATE_INVALID");
    expect(() =>
      fixture.db.transactionImmediate(() =>
        fixture.operations.replaceInTransaction(
          validatingOperation(current),
          current.revision + 1,
        ),
      ),
    ).toThrow("IMPORT_OPERATION_REVISION_CONFLICT");
    expect(() =>
      fixture.db.transactionImmediate(() =>
        fixture.operations.replaceInTransaction(
          { ...validatingOperation(current), revision: 2 },
          current.revision,
        ),
      ),
    ).toThrow("IMPORT_OPERATION_REVISION_INVALID");
  });

  it("rejects invalid transitions, mutable identities, keys, and pinned facts", async () => {
    const fixture = await harness([ids.operation, ids.reservation, ids.action]);
    const uploaded = (
      await fixture.service.upload(
        uploadRequest(Buffer.from("transition-archive"), "transition-upload"),
      )
    ).current;
    const validating = fixture.db.transactionImmediate(() =>
      fixture.operations.replaceInTransaction(
        validatingOperation(uploaded),
        uploaded.revision,
      ),
    );
    for (const candidate of [
      { ...validating, revision: 2, state: "uploaded" as const },
      { ...validating, revision: 2, sourceArchiveHash: "f".repeat(64) },
      { ...validating, revision: 2, reservationKey: `${ids.reservation2}.zip` },
      { ...validating, revision: 2, stagingKey: ids.action2 },
    ])
      expect(() =>
        fixture.db.transactionImmediate(() =>
          fixture.operations.replaceInTransaction(
            candidate,
            validating.revision,
          ),
        ),
      ).toThrow();
    const ready = fixture.db.transactionImmediate(() =>
      fixture.operations.replaceInTransaction(
        planReadyOperation(validating),
        validating.revision,
      ),
    );
    expect(() =>
      fixture.db.transactionImmediate(() =>
        fixture.operations.replaceInTransaction(
          { ...ready, revision: 3, normalizedManifestHash: "f".repeat(64) },
          ready.revision,
        ),
      ),
    ).toThrow("IMPORT_OPERATION_VALIDATION_FACT_CHANGED");
  });
});

async function harness(idValues: string[]) {
  const directory = await temporaryDirectory("hekayati-import-upload-");
  const db = new DocumentStore(join(directory.path, "app.sqlite"));
  cleanups.push(async () => {
    db.close();
    await directory.cleanup();
  });
  const root = join(directory.path, "imports");
  const managed = new ManagedImportStore(root);
  const operations = new ImportOperationRepository(db, () => installationId);
  const actions = new PortabilityActionRepository(db);
  const idFactory = sequence(idValues);
  const service = new ImportUploadService(db, operations, actions, managed, {
    nowIso: () => at,
    idFactory,
  });
  return {
    db,
    workspace: directory.path,
    root,
    managed,
    operations,
    actions,
    service,
  };
}

function uploadRequest(
  bytes: Buffer,
  idempotencyKey: string,
  onOpen: () => void = () => undefined,
) {
  return {
    idempotencyKey,
    declaredArchiveHash: sha256(bytes),
    declaredArchiveBytes: bytes.byteLength,
    openSource: () => {
      onOpen();
      return Readable.from(bytes);
    },
  };
}

function sequence(values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("SYNTHETIC_ID_SEQUENCE_EXHAUSTED");
    index += 1;
    return value;
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function managedImportFixture(): Promise<ManagedImportStore> {
  const directory = await temporaryDirectory("hekayati-import-boundary-");
  cleanups.push(directory.cleanup);
  return new ManagedImportStore(join(directory.path, "imports"));
}

function validatingOperation(
  current: Awaited<ReturnType<ImportUploadService["upload"]>>["current"],
) {
  return {
    ...current,
    revision: current.revision + 1,
    state: "validating" as const,
    stagingKey: ids.operation2,
  };
}

function planReadyOperation(
  current: Awaited<ReturnType<ImportUploadService["upload"]>>["current"],
) {
  const hash = "e".repeat(64);
  return {
    ...current,
    revision: current.revision + 1,
    state: "plan_ready" as const,
    manifestVersion: 2 as const,
    normalizedManifestHash: hash,
    sourceSnapshotHash: hash,
    participantRegistryHash: hash,
    archiveMode: "project" as const,
    mode: null,
    documentCount: 1,
    totalUncompressedBytes: 1,
    diskFacts: {
      freeBytes: 10,
      reserveBytes: 1,
      requiredBytes: 2,
      declaredUncompressedBytes: 1,
      newContentBytes: 0,
      canonicalDocumentBytes: 1,
    },
    migrationSummary: {
      sourceManifestVersion: 2 as const,
      normalizedManifestVersion: 2 as const,
      migratedManifest: false,
      migratedDocumentCount: 0,
    },
  };
}
