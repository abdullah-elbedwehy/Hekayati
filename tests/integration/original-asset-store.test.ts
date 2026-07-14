import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStore } from "../../src/assets/asset-store.js";
import { OriginalAssetStore } from "../../src/assets/original-asset-store.js";
import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { createRuntime } from "../../src/server/app.js";
import { httpRequest } from "../helpers/http.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("private original asset namespace", () => {
  it("stores exact bytes privately, deduplicates, and never places them under derived assets", async () => {
    const fixture = await originalFixture();
    const bytes = Buffer.from("synthetic-exact-photo");

    const first = await fixture.originals.put({
      bytes,
      extension: "jpg",
      sourceMime: "image/jpeg",
    });
    const second = await fixture.originals.put({
      bytes,
      extension: ".JPG",
      sourceMime: "image/jpeg",
    });

    expect(second.id).toBe(first.id);
    expect(second.refCount).toBe(2);
    expect(await fixture.originals.read(first.id)).toEqual(bytes);
    const path = fixture.originals.pathForRecord(first);
    expect(path.startsWith(`${fixture.paths.originals}/`)).toBe(true);
    expect(path.startsWith(`${fixture.paths.assets}/`)).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(fixture.paths.originals)).mode & 0o777).toBe(0o700);
  });

  it("rejects a claimed original extension that disagrees with detected MIME", async () => {
    const fixture = await originalFixture();
    await expect(
      fixture.originals.put({
        bytes: Buffer.from("synthetic-mime-mismatch"),
        extension: "png",
        sourceMime: "image/jpeg",
      }),
    ).rejects.toThrow("ORIGINAL_MIME_EXTENSION_MISMATCH");
    expect(fixture.originals.list()).toEqual([]);
  });

  it("reports corruption through combined runtime health and never rewrites it", async () => {
    const directory = await temporaryDirectory("hekayati-original-health-");
    cleanups.push(directory.cleanup);
    const paths = resolveDataPaths(join(directory.path, "data"));
    await prepareDataPaths(paths);
    const store = new DocumentStore(paths.database);
    const originals = new OriginalAssetStore(store, paths.originals);
    const record = await originals.put({
      bytes: Buffer.from("healthy-original"),
      extension: "png",
      sourceMime: "image/png",
    });
    const path = originals.pathForRecord(record);
    store.close();
    await writeFile(path, "corrupt-original", { mode: 0o600 });

    const runtime = await createRuntime({
      dataDir: paths.root,
      serveUi: false,
    });
    cleanups.push(() => runtime.close());
    const origin = await runtime.start();
    const health = JSON.parse((await httpRequest(origin, "/api/health")).body);

    expect(health.integrity.issues).toContainEqual({
      assetId: record.id,
      reason: "checksum_mismatch",
    });
    expect(await readFile(path, "utf8")).toBe("corrupt-original");
  });

  it("collects only reserved unindexed names at the exact managed depth", async () => {
    const fixture = await originalFixture();
    const prefix = join(fixture.paths.originals, "aa");
    await mkdir(prefix, { recursive: true, mode: 0o700 });
    const temporary = join(prefix, ".hekayati-tmp-reservation");
    const orphan = join(prefix, `${"a".repeat(64)}.jpg`);
    const notes = join(prefix, "operator-notes.txt");
    await writeFile(temporary, "partial", { mode: 0o600 });
    await writeFile(orphan, "orphan", { mode: 0o600 });
    await writeFile(notes, "keep", { mode: 0o600 });

    expect((await fixture.originals.garbageCollectOrphans()).sort()).toEqual(
      [temporary, orphan].sort(),
    );
    expect(await readFile(notes, "utf8")).toBe("keep");
  });

  it("rejects a symlinked hash directory without touching the target", async () => {
    const fixture = await originalFixture();
    const bytes = Buffer.from("find-a-nonexistent-prefix");
    const prefix = createHash("sha256").update(bytes).digest("hex").slice(0, 2);
    const external = join(fixture.directory.path, "external");
    await mkdir(external, { mode: 0o700 });
    await chmod(external, 0o755);
    await symlink(external, join(fixture.paths.originals, prefix));

    await expect(
      fixture.originals.put({
        bytes,
        extension: "heic",
        sourceMime: "image/heic",
      }),
    ).rejects.toThrow("INVALID_ORIGINAL_ASSET_DIRECTORY");
    expect((await stat(external)).mode & 0o777).toBe(0o755);
  });

  it("commits prepared original and derivatives in one database transaction", async () => {
    const fixture = await originalFixture();
    const assets = new AssetStore(fixture.store, fixture.paths.assets);
    const original = await fixture.originals.prepare({
      bytes: Buffer.from("exact-prepared"),
      extension: "png",
      sourceMime: "image/png",
    });
    const thumbnail = await assets.prepare({
      bytes: Buffer.from("clean-thumbnail"),
      extension: "png",
      mime: "image/png",
      role: "thumbnail",
      origin: "derived",
      exifStripped: true,
    });
    expect(fixture.originals.list()).toEqual([]);
    expect(assets.list()).toEqual([]);

    fixture.store.transaction(() => {
      fixture.originals.commitPrepared(original);
      assets.commitPrepared(thumbnail);
    });

    expect(fixture.originals.list().map((record) => record.id)).toEqual([
      original.record.id,
    ]);
    expect(assets.list().map((record) => record.id)).toEqual([
      thumbnail.record.id,
    ]);
  });

  it("rolls back prepared metadata and compensates files after a failed owner commit", async () => {
    const fixture = await originalFixture();
    const assets = new AssetStore(fixture.store, fixture.paths.assets);
    const original = await fixture.originals.prepare({
      bytes: Buffer.from("rollback-exact"),
      extension: "jpg",
      sourceMime: "image/jpeg",
    });
    const working = await assets.prepare({
      bytes: Buffer.from("rollback-working"),
      extension: "jpg",
      mime: "image/jpeg",
      role: "reference_photo",
      origin: "derived",
      exifStripped: true,
    });

    expect(() =>
      fixture.store.transaction(() => {
        fixture.originals.commitPrepared(original);
        assets.commitPrepared(working);
        throw new Error("OWNER_COMMIT_FAILED");
      }),
    ).toThrow("OWNER_COMMIT_FAILED");
    expect(fixture.originals.list()).toEqual([]);
    expect(assets.list()).toEqual([]);

    await Promise.all([
      fixture.originals.discardPrepared(original),
      assets.discardPrepared(working),
    ]);
    await expect(
      stat(fixture.originals.pathForRecord(original.record)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(assets.pathForRecord(working.record)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function originalFixture() {
  const directory = await temporaryDirectory("hekayati-original-");
  cleanups.push(directory.cleanup);
  const paths = resolveDataPaths(join(directory.path, "data"));
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  cleanups.push(async () => store.close());
  const originals = new OriginalAssetStore(store, paths.originals);
  return { directory, paths, store, originals };
}
