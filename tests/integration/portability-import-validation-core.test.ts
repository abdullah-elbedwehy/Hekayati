import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson } from "../../src/contracts/canonical-json.js";
import { readImportValidationIndex } from "../../src/portability/import-validation-store.js";
import {
  readStagedImportEntry,
  type StagedImportEntry,
} from "../../src/portability/zip-reader.js";
import {
  IMPORT_VALIDATION_AT as at,
  IMPORT_VALIDATION_ENTITY as entity,
  archiveEntries,
  cleanupImportValidationFixtures,
  collectZip,
  expectArchiveRejected,
  harness,
  legacyManifestForArchive,
  manifestWithFirstDocumentBytes,
  mutateCentralDiskStart,
  mutateEncryptedArchive,
  mutateLocalHeaderName,
  mutateLocalMethod,
  mutateLocalNameLength,
  mutateLocalSignature,
  mutateMultiDiskArchive,
  prefixedBytes,
  productDocumentCount,
  sha256,
  syntheticArchive,
  syntheticRegistry,
} from "../helpers/portability-import-validation-fixture.js";

afterEach(cleanupImportValidationFixtures);

describe("T-P9-02 staged import validation", () => {
  it("reaches plan_ready only after two disk checks, closure, media, and hooks", async () => {
    let hooks = 0;
    const registry = syntheticRegistry({
      onAssetValidated: () => (hooks += 1),
    });
    const archive = await syntheticArchive();
    const fixture = await harness(registry, archive);

    const [operation, concurrent] = await Promise.all([
      fixture.validation.validate(entity.operation),
      fixture.validation.validate(entity.operation),
    ]);
    expect(concurrent).toEqual(operation);
    expect(operation).toMatchObject({
      state: "plan_ready",
      manifestVersion: 2,
      normalizedManifestHash: archive.manifest.manifestHash,
      participantRegistryHash: registry.hash,
      archiveMode: "project",
      documentCount: 4,
      mediaCount: 1,
      migrationSummary: {
        sourceManifestVersion: 2,
        normalizedManifestVersion: 2,
        migratedManifest: false,
        migratedDocumentCount: 0,
      },
      planId: null,
      actionRefs: { latestPlanActionId: null, commitActionId: null },
    });
    expect(operation.sourceSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.diskChecks).toHaveLength(2);
    expect(hooks).toBe(1);
    const staging = join(fixture.managed.stagingRoot, operation.stagingKey!);
    expect(await readdir(staging)).toEqual([
      "000000.entry",
      "000001.entry",
      "000002.entry",
      "000003.entry",
      "000004.entry",
      "index.json",
      "normalized",
      "normalized-manifest.json",
      "validation-index.json",
    ]);
    const validationIndex = await readImportValidationIndex(staging);
    expect(validationIndex).toMatchObject({
      schemaVersion: 1,
      graphHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceSnapshotHash: operation.sourceSnapshotHash,
      migratedDocumentCount: 0,
    });
    expect(validationIndex.documents).toHaveLength(4);
    expect(validationIndex.media).toHaveLength(1);
    expect(productDocumentCount(fixture.db)).toBe(0);

    const stagingIndex = JSON.parse(
      await readFile(join(staging, "index.json"), "utf8"),
    ) as { entries: StagedImportEntry[] };
    await expect(
      readStagedImportEntry(
        { directory: staging, entries: stagingIndex.entries },
        "data/projects/missing.json",
      ),
    ).rejects.toThrow("IMPORT_ARCHIVE_ENTRY_MISSING");
    const stagedPath = join(staging, stagingIndex.entries[0].managedName);
    await chmod(stagedPath, 0o644);
    await expect(
      readStagedImportEntry(
        { directory: staging, entries: stagingIndex.entries },
        stagingIndex.entries[0].archivePath,
      ),
    ).rejects.toThrow("IMPORT_STAGING_FILE_IDENTITY_INVALID");
    await chmod(stagedPath, 0o600);

    const replay = await fixture.validation.validate(entity.operation);
    expect(replay).toEqual(operation);
    expect(fixture.diskChecks).toHaveLength(2);
    expect(hooks).toBe(1);
  });

  it("fails closed on validation-index permission, canonical-byte, or fact tampering", async () => {
    const archive = await syntheticArchive();
    const fixture = await harness(syntheticRegistry(), archive);
    const operation = await fixture.validation.validate(entity.operation);
    const staging = join(fixture.managed.stagingRoot, operation.stagingKey!);
    const indexPath = join(staging, "validation-index.json");
    const canonical = await readFile(indexPath, "utf8");

    await chmod(indexPath, 0o644);
    await expect(readImportValidationIndex(staging)).rejects.toThrow(
      "IMPORT_VALIDATION_INDEX_IDENTITY_INVALID",
    );
    await chmod(indexPath, 0o600);
    await writeFile(indexPath, `${canonical}\n`, { mode: 0o600 });
    await expect(readImportValidationIndex(staging)).rejects.toThrow(
      "IMPORT_VALIDATION_INDEX_NOT_CANONICAL",
    );
    const tampered = JSON.parse(canonical) as Record<string, unknown>;
    const media = tampered.media as Array<Record<string, unknown>>;
    media[0] = { ...media[0], untrusted: true };
    await writeFile(indexPath, canonicalJson(tampered), { mode: 0o600 });
    await expect(readImportValidationIndex(staging)).rejects.toThrow();
  });

  it("purely migrates a declared participant document before plan_ready", async () => {
    const registry = syntheticRegistry({ projectVersion: 2 });
    const archive = await syntheticArchive({ projectVersion: 1 });
    const fixture = await harness(registry, archive);
    const operation = await fixture.validation.validate(entity.operation);
    expect(operation.state).toBe("plan_ready");
    expect(operation.migrationSummary).toMatchObject({
      migratedDocumentCount: 1,
    });
    const staging = join(fixture.managed.stagingRoot, operation.stagingKey!);
    const normalized = JSON.parse(
      await readFile(
        join(staging, "normalized", "document-000003.json"),
        "utf8",
      ),
    );
    expect(normalized).toMatchObject({ schemaVersion: 2, migrated: true });
    expect(archive.projectBytes.toString("utf8")).not.toContain("migrated");
  });

  it("stages the frozen v1 archive through pure normalization to plan_ready", async () => {
    const archive = await syntheticArchive();
    const legacy = legacyManifestForArchive(archive);
    const entries = archiveEntries(archive);
    entries[0] = {
      path: "manifest.json",
      bytes: Buffer.from(canonicalJson(legacy)),
    };
    const bytes = await collectZip(entries);
    const externalHash = sha256(bytes);
    const fixture = await harness(syntheticRegistry(), { ...archive, bytes });
    const operation = await fixture.validation.validate(entity.operation);
    expect(operation).toMatchObject({
      state: "plan_ready",
      manifestVersion: 1,
      migrationSummary: {
        sourceManifestVersion: 1,
        normalizedManifestVersion: 2,
        migratedManifest: true,
      },
      sourceArchiveHash: externalHash,
    });
    expect(sha256(bytes)).toBe(externalHash);
    expect(operation.normalizedManifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects future, missing, failed, invalid, and mode-forbidden participant schemas", async () => {
    const cases = [
      {
        expected: "IMPORT_ARCHIVE_DOCUMENT_FUTURE_VERSION",
        registry: syntheticRegistry(),
        archive: syntheticArchive({ projectVersion: 2 }),
      },
      {
        expected: "IMPORT_ARCHIVE_DOCUMENT_MIGRATION_MISSING",
        registry: syntheticRegistry({
          projectVersion: 2,
          migration: "missing",
        }),
        archive: syntheticArchive({ projectVersion: 1 }),
      },
      {
        expected: "IMPORT_ARCHIVE_DOCUMENT_MIGRATION_FAILED",
        registry: syntheticRegistry({ projectVersion: 2, migration: "throws" }),
        archive: syntheticArchive({ projectVersion: 1 }),
      },
      {
        expected: "IMPORT_ARCHIVE_DOCUMENT_MIGRATION_INVALID",
        registry: syntheticRegistry({
          projectVersion: 2,
          migration: "wrong-version",
        }),
        archive: syntheticArchive({ projectVersion: 1 }),
      },
      {
        expected: "IMPORT_ARCHIVE_COLLECTION_MODE_FORBIDDEN",
        registry: syntheticRegistry({ projectExportModes: [] }),
        archive: syntheticArchive(),
      },
    ];
    for (const candidate of cases) {
      const fixture = await harness(
        candidate.registry,
        await candidate.archive,
      );
      await expect(
        fixture.validation.validate(entity.operation),
      ).rejects.toThrow(candidate.expected);
      expect(productDocumentCount(fixture.db)).toBe(0);
      await fixture.cleanupNow();
    }
  });

  it("fails closed and cleans only managed residue for schema, closure, secret, and media faults", async () => {
    const cases = [
      {
        expected: "IMPORT_ARCHIVE_PARTICIPANT_SCHEMA_INVALID",
        archive: syntheticArchive({ projectExtra: { unknown: true } }),
      },
      {
        expected: "PORTABILITY_DOCUMENT_REFERENCE_MISSING",
        archive: syntheticArchive({ omitFamily: true }),
      },
      {
        expected: "IMPORT_ARCHIVE_SECRET_FOUND",
        archive: syntheticArchive({ projectNote: "HEKAYATI_SECRET_CANARY" }),
      },
      {
        expected: "IMPORT_ARCHIVE_IMAGE_DECODE_FAILED",
        archive: syntheticArchive({ mediaBytes: Buffer.from("not-a-png") }),
      },
    ];
    for (const candidate of cases) {
      const archive = await candidate.archive;
      const fixture = await harness(syntheticRegistry(), archive);
      await expect(
        fixture.validation.validate(entity.operation),
      ).rejects.toThrow(candidate.expected);
      expect(fixture.operations.get(entity.operation)).toMatchObject({
        state: "failed",
        reservationKey: null,
        stagingKey: null,
        cleanupState: "complete",
      });
      expect(await readdir(join(fixture.managed.root, "reservations"))).toEqual(
        [],
      );
      expect(await readdir(fixture.managed.stagingRoot)).toEqual([]);
      expect(productDocumentCount(fixture.db)).toBe(0);
      await fixture.cleanupNow();
    }
  });

  it("rejects malformed canonical documents, manifest identity drift, roots, modes, and extra closure", async () => {
    const cases = [
      [
        "IMPORT_ARCHIVE_DOCUMENT_JSON_INVALID",
        syntheticArchive({ projectEncoding: "invalid-json" }),
      ],
      [
        "IMPORT_ARCHIVE_DOCUMENT_UTF8_INVALID",
        syntheticArchive({ projectEncoding: "invalid-utf8" }),
      ],
      [
        "IMPORT_ARCHIVE_DOCUMENT_NOT_CANONICAL",
        syntheticArchive({ projectEncoding: "noncanonical" }),
      ],
      [
        "IMPORT_ARCHIVE_DOCUMENT_VERSION_MISMATCH",
        syntheticArchive({ projectManifestVersion: 2 }),
      ],
      [
        "IMPORT_ARCHIVE_DOCUMENT_ID_MISMATCH",
        syntheticArchive({ projectManifestId: entity.extra }),
      ],
      [
        "IMPORT_ARCHIVE_COLLECTION_UNREGISTERED",
        syntheticArchive({ projectCollection: "unknown_projects" }),
      ],
      [
        "IMPORT_ARCHIVE_ROOT_SET_INVALID",
        syntheticArchive({ omitFamilyRoot: true }),
      ],
      [
        "IMPORT_ARCHIVE_DOCUMENT_CLOSURE_MISMATCH",
        syntheticArchive({ extraCustomer: true }),
      ],
    ] as const;
    for (const [expected, archive] of cases)
      await expectArchiveRejected(
        await archive,
        (await archive).bytes,
        expected,
      );
    const hookArchive = await syntheticArchive();
    const hookFixture = await harness(
      syntheticRegistry({
        onAssetValidated: () => {
          throw new Error("unsafe lower-case detail");
        },
      }),
      hookArchive,
    );
    await expect(
      hookFixture.validation.validate(entity.operation),
    ).rejects.toThrow("IMPORT_ARCHIVE_PARTICIPANT_VALIDATION_FAILED");
    expect(productDocumentCount(hookFixture.db)).toBe(0);
  });

  it("resumes a durable validating operation after a restart", async () => {
    const registry = syntheticRegistry();
    const archive = await syntheticArchive();
    const fixture = await harness(registry, archive, { beginOnly: true });
    const uploaded = fixture.operations.get(entity.operation)!;
    const validating = fixture.db.transactionImmediate(() =>
      fixture.operations.replaceInTransaction(
        {
          ...uploaded,
          revision: 1,
          updatedAt: at,
          state: "validating",
          stagingKey: entity.staging,
        },
        0,
      ),
    );
    expect(validating.state).toBe("validating");
    const recovery = await fixture.validation.recover();
    expect(recovery.resumed).toEqual([entity.operation]);
    expect(fixture.operations.get(entity.operation)?.state).toBe("plan_ready");
  });

  it("cleans all managed residue when free space fails before extraction or after validation", async () => {
    const archive = await syntheticArchive();
    for (const failDiskAt of [1, 2] as const) {
      const fixture = await harness(syntheticRegistry(), archive, {
        failDiskAt,
      });
      await expect(
        fixture.validation.validate(entity.operation),
      ).rejects.toThrow("IMPORT_DISK_SPACE_INSUFFICIENT");
      expect(fixture.diskChecks).toHaveLength(failDiskAt);
      expect(fixture.operations.get(entity.operation)).toMatchObject({
        state: "failed",
        reservationKey: null,
        stagingKey: null,
        cleanupState: "complete",
      });
      expect(await readdir(join(fixture.managed.root, "reservations"))).toEqual(
        [],
      );
      expect(await readdir(fixture.managed.stagingRoot)).toEqual([]);
      expect(productDocumentCount(fixture.db)).toBe(0);
      await fixture.cleanupNow();
    }
  });

  it("durably retries an interrupted cleanup without deleting unknown files", async () => {
    const archive = await syntheticArchive({ projectExtra: { unknown: true } });
    const fixture = await harness(syntheticRegistry(), archive);
    await writeFile(
      join(fixture.managed.root, "reservations", "operator-unknown.txt"),
      "preserve",
      { mode: 0o600 },
    );
    const removal = vi
      .spyOn(fixture.managed, "removeStaging")
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      );
    await expect(fixture.validation.validate(entity.operation)).rejects.toThrow(
      "IMPORT_ARCHIVE_PARTICIPANT_SCHEMA_INVALID",
    );
    expect(fixture.operations.get(entity.operation)).toMatchObject({
      state: "cleanup_required",
      cleanupState: "failed",
      reservationKey: `${entity.reservation}.zip`,
      stagingKey: entity.staging,
    });
    removal.mockRestore();
    const recovery = await fixture.validation.recover();
    expect(recovery.cleanupRetried).toEqual([entity.operation]);
    expect(fixture.operations.get(entity.operation)).toMatchObject({
      state: "failed",
      cleanupState: "complete",
      reservationKey: null,
      stagingKey: null,
    });
    expect(await readdir(join(fixture.managed.root, "reservations"))).toEqual([
      "operator-unknown.txt",
    ]);
    expect(await readdir(fixture.managed.stagingRoot)).toEqual([]);
  });

  it("rejects corrupt, truncated, encrypted, multi-disk, and mismatched local headers", async () => {
    const archive = await syntheticArchive();
    const cases = [
      ["IMPORT_ARCHIVE_CORRUPT", Buffer.from("synthetic-not-a-zip")],
      [
        "IMPORT_ARCHIVE_CORRUPT",
        Buffer.from(archive.bytes.subarray(0, archive.bytes.byteLength - 12)),
      ],
      ["IMPORT_ARCHIVE_ENCRYPTED", mutateEncryptedArchive(archive.bytes)],
      ["IMPORT_ARCHIVE_MULTI_DISK", mutateMultiDiskArchive(archive.bytes)],
      ["IMPORT_ARCHIVE_MULTI_DISK", mutateCentralDiskStart(archive.bytes)],
      [
        "IMPORT_ARCHIVE_LOCAL_HEADER_INVALID",
        mutateLocalSignature(archive.bytes),
      ],
      [
        "IMPORT_ARCHIVE_LOCAL_HEADER_MISMATCH",
        mutateLocalMethod(archive.bytes),
      ],
      [
        "IMPORT_ARCHIVE_LOCAL_HEADER_MISMATCH",
        mutateLocalNameLength(archive.bytes),
      ],
      [
        "IMPORT_ARCHIVE_LOCAL_HEADER_MISMATCH",
        mutateLocalHeaderName(archive.bytes),
      ],
    ] as const;
    for (const [expected, bytes] of cases)
      await expectArchiveRejected(archive, bytes, expected);
  });

  it("rejects missing, extra, duplicate, checksum, active-content, and non-regular entries", async () => {
    const archive = await syntheticArchive();
    const entries = archiveEntries(archive);
    const wrongBytesManifest = manifestWithFirstDocumentBytes(archive, 1);
    const wrongBytesEntries = [
      {
        path: "manifest.json",
        bytes: Buffer.from(canonicalJson(wrongBytesManifest)),
      },
      ...entries.slice(1),
    ];
    const changed = Buffer.from(entries[1].bytes);
    changed[changed.byteLength - 1] ^= 1;
    const cases = [
      ["IMPORT_ARCHIVE_MANIFEST_MISSING", await collectZip(entries.slice(1))],
      [
        "IMPORT_ARCHIVE_LISTED_ENTRY_SET_MISMATCH",
        await collectZip(entries.slice(0, -1)),
      ],
      [
        "IMPORT_ARCHIVE_LISTED_ENTRY_SET_MISMATCH",
        await collectZip([
          ...entries,
          {
            path: "data/customers/synthetic-extra.json",
            bytes: Buffer.from("{}"),
          },
        ]),
      ],
      [
        "IMPORT_ARCHIVE_UNLISTED_ENTRY",
        await collectZip([
          ...entries.slice(0, -1),
          {
            path: "data/customers/synthetic-extra.json",
            bytes: Buffer.from("{}"),
          },
        ]),
      ],
      [
        "IMPORT_ARCHIVE_DECLARED_BYTES_MISMATCH",
        await collectZip(wrongBytesEntries),
      ],
      [
        "IMPORT_ARCHIVE_NAME_COLLISION",
        await collectZip([...entries, entries[1]]),
      ],
      [
        "IMPORT_ARCHIVE_ENTRY_CHECKSUM_MISMATCH",
        await collectZip([
          entries[0],
          { ...entries[1], bytes: changed },
          ...entries.slice(2),
        ]),
      ],
      [
        "IMPORT_ARCHIVE_EXECUTABLE_CONTENT",
        await collectZip([
          entries[0],
          { ...entries[1], bytes: prefixedBytes(entries[1].bytes, "MZ") },
          ...entries.slice(2),
        ]),
      ],
      [
        "IMPORT_ARCHIVE_NESTED_ARCHIVE",
        await collectZip([
          entries[0],
          {
            ...entries[1],
            bytes: prefixedBytes(entries[1].bytes, "PK\u0003\u0004"),
          },
          ...entries.slice(2),
        ]),
      ],
      [
        "IMPORT_ARCHIVE_NON_REGULAR",
        await collectZip([
          { ...entries[0], mode: 0o120600 },
          ...entries.slice(1),
        ]),
      ],
      ["IMPORT_ARCHIVE_COMMENT_UNSUPPORTED", await collectZip(entries, "no")],
      [
        "IMPORT_ARCHIVE_ENTRY_COMMENT_UNSUPPORTED",
        await collectZip([
          { ...entries[0], fileComment: "no" },
          ...entries.slice(1),
        ]),
      ],
      [
        "IMPORT_ARCHIVE_EXTRA_FIELD_UNSUPPORTED",
        await collectZip([
          { ...entries[0], forceDosTimestamp: false },
          ...entries.slice(1),
        ]),
      ],
    ] as const;
    for (const [expected, bytes] of cases)
      await expectArchiveRejected(archive, bytes, expected);
  });
});
