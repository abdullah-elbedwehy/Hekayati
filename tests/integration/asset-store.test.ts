import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import {
  AssetStore,
  type AssetInput,
  type AssetStoreHooks,
} from "../../src/assets/asset-store.js";
import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("content-addressed asset store", () => {
  it("rejects symlinked hash directories and files without touching their targets", async () => {
    const directoryFixture = await assetFixture();
    const directoryInput = assetInput("symlink-directory");
    const directoryHash = createHash("sha256")
      .update(directoryInput.bytes)
      .digest("hex");
    const externalDirectory = join(
      directoryFixture.directory.path,
      "external-dir",
    );
    await mkdir(externalDirectory, { mode: 0o700 });
    await symlink(
      externalDirectory,
      join(directoryFixture.paths.assets, directoryHash.slice(0, 2)),
    );
    await expect(directoryFixture.assets.put(directoryInput)).rejects.toThrow(
      "INVALID_ASSET_DIRECTORY",
    );

    const fileFixture = await assetFixture();
    const fileInput = assetInput("symlink-file");
    const fileHash = createHash("sha256").update(fileInput.bytes).digest("hex");
    const prefix = join(fileFixture.paths.assets, fileHash.slice(0, 2));
    const externalFile = join(fileFixture.directory.path, "external-file");
    await mkdir(prefix, { mode: 0o700 });
    await writeFile(externalFile, "must remain", { mode: 0o600 });
    await symlink(externalFile, join(prefix, `${fileHash}.bin`));
    await expect(fileFixture.assets.put(fileInput)).rejects.toThrow(
      "INVALID_ASSET_FILE",
    );
    expect(await readFile(externalFile, "utf8")).toBe("must remain");
  });

  it("atomically stores, secures, and deduplicates identical bytes", async () => {
    const fixture = await assetFixture();
    const input = {
      bytes: Buffer.from("same durable bytes"),
      extension: ".png",
      mime: "image/png",
      role: "thumbnail" as const,
      origin: "derived" as const,
    };
    const first = await fixture.assets.put(input);
    const second = await fixture.assets.put(input);

    expect(second.id).toBe(first.id);
    expect(second.refCount).toBe(2);
    expect(fixture.assets.list()).toHaveLength(1);
    const path = fixture.assets.pathForRecord(first);
    expect(await readFile(path)).toEqual(input.bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(fixture.paths.assets, first.sha256.slice(0, 2)))).mode &
        0o777,
    ).toBe(0o700);
  });

  it("retains references and unlinks bytes only when the last reference releases", async () => {
    const fixture = await assetFixture();
    const first = await fixture.assets.put(assetInput("referenced"));
    const path = fixture.assets.pathForRecord(first);

    expect(fixture.assets.retain(first.id).refCount).toBe(2);
    expect((await fixture.assets.release(first.id))?.refCount).toBe(1);
    expect(await readFile(path, "utf8")).toBe("asset-referenced");
    expect(await fixture.assets.release(first.id)).toBeNull();
    expect(fixture.assets.get(first.id)).toBeNull();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fixture.assets.release(first.id)).rejects.toThrow(
      "ASSET_NOT_FOUND",
    );
  });

  it("persists canonical image metadata, provenance, and EXIF state", async () => {
    const fixture = await assetFixture();
    const jobId = ulid();
    const referencedAssetId = ulid();
    const record = await fixture.assets.put({
      ...assetInput("metadata"),
      width: 1800,
      height: 1200,
      dpi: 300,
      exifStripped: true,
      provenance: provenance({
        jobId,
        referencedAssetIds: [referencedAssetId],
      }),
    });

    expect(record).toMatchObject({
      width: 1800,
      height: 1200,
      dpi: 300,
      exifStripped: true,
      provenance: { jobId, referencedAssetIds: [referencedAssetId] },
    });
  });

  it("rejects arbitrary secret or provider payload fields before persistence", async () => {
    const fixture = await assetFixture();
    const secret = "SECRET_PROVENANCE_CANARY";
    const unsafe = {
      ...assetInput("unsafe-provenance"),
      origin: "generated",
      role: "illustration",
      provenance: {
        ...provenance(),
        settingsSnapshot: {
          schemaVersion: 1,
          settingsHash: "a".repeat(64),
          apiKey: secret,
          nested: { childPhotoBase64: "PRIVATE_PHOTO_CANARY" },
        },
      },
    } as AssetInput;

    await expect(fixture.assets.put(unsafe)).rejects.toThrow();
    const keyShaped = {
      ...assetInput("key-shaped-provenance"),
      origin: "generated",
      role: "illustration",
      provenance: {
        ...provenance(),
        model: "AIza1234567890123456789012345",
      },
    } as AssetInput;
    await expect(fixture.assets.put(keyShaped)).rejects.toThrow(
      "SECRET_PERSISTENCE_FORBIDDEN",
    );
    await expect(
      fixture.assets.put({
        ...assetInput("key-shaped-bytes"),
        bytes: Buffer.from("AIza1234567890123456789012345"),
      }),
    ).rejects.toThrow("SECRET_PERSISTENCE_FORBIDDEN");
    expect(fixture.assets.list()).toEqual([]);
    expect(await fixture.assets.garbageCollectOrphans()).toEqual([]);
    expect((await readFile(fixture.paths.database)).includes(secret)).toBe(
      false,
    );
  });

  it("enforces provenance and sanitized-reference metadata by asset origin and role", async () => {
    const fixture = await assetFixture();
    await expect(
      fixture.assets.put({
        ...assetInput("missing-provenance"),
        origin: "generated",
        role: "illustration",
      }),
    ).rejects.toThrow("GENERATED_ASSET_REQUIRES_PROVENANCE");
    await expect(
      fixture.assets.put({
        ...assetInput("unsafe-photo"),
        origin: "upload",
        role: "reference_photo",
        mime: "image/jpeg",
        exifStripped: false,
      }),
    ).rejects.toThrow("REFERENCE_PHOTO_REQUIRES_EXIF_STRIPPING");
    expect(fixture.assets.list()).toEqual([]);
  });

  it("rejects conflicting metadata when identical bytes are deduplicated", async () => {
    const fixture = await assetFixture();
    const first = await fixture.assets.put(assetInput("metadata-conflict"));
    await expect(
      fixture.assets.put({
        ...assetInput("metadata-conflict"),
        mime: "image/png",
        origin: "generated",
        role: "illustration",
        width: 1200,
        height: 1200,
        provenance: provenance(),
      }),
    ).rejects.toThrow("ASSET_METADATA_CONFLICT");

    expect(fixture.assets.get(first.id)).toMatchObject({
      refCount: 1,
      role: "thumbnail",
      origin: "derived",
    });
    expect(fixture.assets.get(first.id)?.provenance).toBeUndefined();
  });

  it("deduplicates structurally identical provenance regardless of map key order", async () => {
    const fixture = await assetFixture();
    const character = ulid();
    const look = ulid();
    const canonical = provenance({
      inputVersionRefs: { character, look },
    });
    const input = {
      ...assetInput("canonical-metadata"),
      origin: "generated" as const,
      role: "illustration" as const,
      mime: "image/png",
      provenance: canonical,
    };
    const first = await fixture.assets.put(input);
    const second = await fixture.assets.put({
      ...input,
      provenance: {
        ...canonical,
        inputVersionRefs: { look, character },
      },
    });

    expect(second.id).toBe(first.id);
    expect(second.refCount).toBe(2);
  });

  it("deduplicates concurrent writes while retaining both references", async () => {
    const fixture = await assetFixture();
    const [first, second] = await Promise.all([
      fixture.assets.put(assetInput("racing")),
      fixture.assets.put(assetInput("racing")),
    ]);

    expect(first.id).toBe(second.id);
    expect(fixture.assets.get(first.id)?.refCount).toBe(2);
    expect(fixture.assets.list()).toHaveLength(1);
  });

  it("serializes a final release against a same-hash replacement", async () => {
    const fixture = await assetFixture();
    const first = await fixture.assets.put(assetInput("release-race"));
    const [released, replacement] = await Promise.all([
      fixture.assets.release(first.id),
      fixture.assets.put(assetInput("release-race")),
    ]);

    expect(released).toBeNull();
    expect(replacement.id).not.toBe(first.id);
    expect(
      await readFile(fixture.assets.pathForRecord(replacement), "utf8"),
    ).toBe("asset-release-race");
    expect((await fixture.assets.scanIntegrity()).issues).toEqual([]);
  });

  it("reports missing and corrupt indexed assets without mutating records or files", async () => {
    const fixture = await assetFixture();
    const missing = await fixture.assets.put(assetInput("missing"));
    const corrupt = await fixture.assets.put(assetInput("corrupt"));
    await rm(fixture.assets.pathForRecord(missing));
    await writeFile(fixture.assets.pathForRecord(corrupt), "changed", {
      mode: 0o600,
    });
    const before = JSON.stringify(fixture.assets.list());

    const report = await fixture.assets.scanIntegrity();

    expect(report.issues).toEqual([
      { assetId: missing.id, reason: "missing" },
      { assetId: corrupt.id, reason: "checksum_mismatch" },
    ]);
    expect(JSON.stringify(fixture.assets.list())).toBe(before);
    expect(await readFile(fixture.assets.pathForRecord(corrupt), "utf8")).toBe(
      "changed",
    );
  });

  it("verifies one referenced checksum without returning asset bytes or mutating state", async () => {
    const fixture = await assetFixture();
    const record = await fixture.assets.put(assetInput("targeted-integrity"));
    const before = JSON.stringify(fixture.assets.list());

    expect(await fixture.assets.verifyIntegrity(record.id)).toEqual({
      assetId: record.id,
      expectedSha256: record.sha256,
      status: "healthy",
      reason: null,
    });

    await rm(fixture.assets.pathForRecord(record));
    expect(await fixture.assets.verifyIntegrity(record.id)).toEqual({
      assetId: record.id,
      expectedSha256: record.sha256,
      status: "missing",
      reason: "missing",
    });

    await writeFile(fixture.assets.pathForRecord(record), "changed", {
      mode: 0o600,
    });
    const corrupt = await fixture.assets.verifyIntegrity(record.id);
    expect(corrupt).toEqual({
      assetId: record.id,
      expectedSha256: record.sha256,
      status: "corrupt",
      reason: "checksum_mismatch",
    });
    expect(Object.keys(corrupt).sort()).toEqual([
      "assetId",
      "expectedSha256",
      "reason",
      "status",
    ]);
    expect(JSON.stringify(fixture.assets.list())).toBe(before);
    expect(await readFile(fixture.assets.pathForRecord(record), "utf8")).toBe(
      "changed",
    );
    await expect(fixture.assets.verifyIntegrity(ulid())).rejects.toThrow(
      "ASSET_NOT_FOUND",
    );
  });

  it("repairs missing or corrupt bytes only on an explicit same-content put", async () => {
    const fixture = await assetFixture();
    const missingInput = assetInput("repair-missing");
    const corruptInput = assetInput("repair-corrupt");
    const missing = await fixture.assets.put(missingInput);
    const corrupt = await fixture.assets.put(corruptInput);
    await rm(fixture.assets.pathForRecord(missing));
    await writeFile(fixture.assets.pathForRecord(corrupt), "corrupt", {
      mode: 0o600,
    });

    expect((await fixture.assets.scanIntegrity()).issues).toHaveLength(2);
    expect((await fixture.assets.put(missingInput)).refCount).toBe(2);
    expect((await fixture.assets.put(corruptInput)).refCount).toBe(2);
    expect((await fixture.assets.scanIntegrity()).issues).toEqual([]);
    expect(await readFile(fixture.assets.pathForRecord(missing))).toEqual(
      missingInput.bytes,
    );
    expect(await readFile(fixture.assets.pathForRecord(corrupt))).toEqual(
      corruptInput.bytes,
    );
  });

  it("does not lose a synchronous retain while an explicit repair awaits disk", async () => {
    const fixture = await assetFixture();
    const input = assetInput("repair-retain-race");
    const record = await fixture.assets.put(input);
    await rm(fixture.assets.pathForRecord(record));

    const repairing = fixture.assets.put(input);
    await Promise.resolve();
    expect(fixture.assets.retain(record.id).refCount).toBe(2);
    expect((await repairing).refCount).toBe(3);
    expect(fixture.assets.get(record.id)?.refCount).toBe(3);
  });

  it("garbage-collects interrupted temp and unindexed rename artifacts only", async () => {
    const fixture = await assetFixture();
    const indexed = await fixture.assets.put(assetInput("indexed"));
    const prefix = join(fixture.paths.assets, "aa");
    await mkdir(prefix, { recursive: true, mode: 0o700 });
    const temporary = join(prefix, ".hekayati-tmp-crash");
    const orphan = join(prefix, `${"a".repeat(64)}.png`);
    const unrelated = join(prefix, "operator-notes.txt");
    const nestedPrefix = join(fixture.paths.assets, "operator-backup", "aa");
    const nestedAsset = join(nestedPrefix, `${"a".repeat(64)}.png`);
    const nestedTemporary = join(nestedPrefix, ".hekayati-tmp-preserve");
    await mkdir(nestedPrefix, { recursive: true, mode: 0o700 });
    await writeFile(temporary, "partial", { mode: 0o600 });
    await writeFile(orphan, "renamed-before-db-commit", { mode: 0o600 });
    await writeFile(unrelated, "do not sweep", { mode: 0o600 });
    await writeFile(nestedAsset, "nested backup", { mode: 0o600 });
    await writeFile(nestedTemporary, "nested temporary", { mode: 0o600 });
    await chmod(prefix, 0o700);

    const removed = await fixture.assets.garbageCollectOrphans();
    expect(removed.sort()).toEqual([orphan, temporary].sort());
    expect(await readFile(fixture.assets.pathForRecord(indexed), "utf8")).toBe(
      "asset-indexed",
    );
    expect(await readFile(unrelated, "utf8")).toBe("do not sweep");
    expect(await readFile(nestedAsset, "utf8")).toBe("nested backup");
    expect(await readFile(nestedTemporary, "utf8")).toBe("nested temporary");
  });

  it.each(["put", "prepare"] as const)(
    "removes a recoverable %s temp file immediately after a write failure",
    async (operation) => {
      const fixture = await assetFixture({
        afterTempSync: () => {
          throw new Error("INJECTED_TEMP_WRITE_FAILURE");
        },
      });
      const input = assetInput(`temp-cleanup-${operation}`);
      const hash = createHash("sha256").update(input.bytes).digest("hex");
      const prefix = join(fixture.paths.assets, hash.slice(0, 2));

      const failedWrite =
        operation === "put"
          ? fixture.assets.put(input)
          : fixture.assets.prepare(input);
      await expect(failedWrite).rejects.toThrow("INJECTED_TEMP_WRITE_FAILURE");

      expect(await readdir(prefix)).toEqual([]);
      expect(await fixture.assets.garbageCollectOrphans()).toEqual([]);
      expect(fixture.assets.list()).toEqual([]);

      const recovered = new AssetStore(fixture.store, fixture.paths.assets);
      const record = await recovered.put(input);
      expect(await recovered.read(record.id)).toEqual(input.bytes);
    },
  );

  it.each(["after_temp_sync", "after_rename_sync"] as const)(
    "recovers safely after SIGKILL at %s",
    async (phase) => {
      const directory = await temporaryDirectory("hekayati-asset-crash-");
      cleanups.push(directory.cleanup);
      const data = join(directory.path, "data");
      const marker = join(directory.path, "ready");
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "tests/fixtures/write-asset-and-hang.ts",
          data,
          marker,
          phase,
        ],
        { cwd: process.cwd(), stdio: "ignore" },
      );
      const exited = once(child, "exit");
      await waitForMarker(marker, child);
      child.kill("SIGKILL");
      const [, signal] = await exited;
      expect(signal).toBe("SIGKILL");

      const paths = resolveDataPaths(data);
      const store = new DocumentStore(paths.database);
      const assets = new AssetStore(store, paths.assets);
      cleanups.push(async () => store.close());
      expect(assets.list()).toEqual([]);
      expect(await assets.garbageCollectOrphans()).toHaveLength(1);
      const first = await assets.put(assetInput("crash-stage"));
      const second = await assets.put(assetInput("crash-stage"));
      expect(second.id).toBe(first.id);
      expect(second.refCount).toBe(2);
      expect((await assets.scanIntegrity()).issues).toEqual([]);
    },
  );

  it("rejects unsafe extensions before creating an asset", async () => {
    const fixture = await assetFixture();
    await expect(
      fixture.assets.put({ ...assetInput("bad"), extension: "../../command" }),
    ).rejects.toThrow("INVALID_ASSET_EXTENSION");
    expect(fixture.assets.list()).toEqual([]);
  });
});

function assetInput(label: string) {
  return {
    bytes: Buffer.from(`asset-${label}`),
    extension: "bin",
    mime: "application/octet-stream",
    origin: "derived" as const,
    role: "thumbnail" as const,
  };
}

function provenance(
  overrides: Partial<NonNullable<AssetInput["provenance"]>> = {},
): NonNullable<AssetInput["provenance"]> {
  return {
    provider: "mock",
    model: "deterministic-fixture",
    at: new Date().toISOString(),
    jobId: ulid(),
    inputVersionRefs: {},
    promptVersion: "fixture-v1",
    referencedAssetIds: [],
    attempt: 1,
    settingsSnapshot: {
      schemaVersion: 1,
      settingsHash: "a".repeat(64),
      qualityMode: "standard",
      output: { minWidthPx: 1800, minHeightPx: 1200 },
    },
    ...overrides,
  };
}

async function assetFixture(hooks: AssetStoreHooks = {}) {
  const directory = await temporaryDirectory();
  cleanups.push(directory.cleanup);
  const paths = resolveDataPaths(join(directory.path, "data"));
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  const assets = new AssetStore(store, paths.assets, hooks);
  cleanups.push(async () => store.close());
  return { directory, paths, store, assets };
}

async function waitForMarker(
  marker: string,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(marker);
      return;
    } catch {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("ASSET_CRASH_FIXTURE_EXITED_EARLY");
      await delay(10);
    }
  }
  throw new Error("ASSET_CRASH_FIXTURE_TIMEOUT");
}
