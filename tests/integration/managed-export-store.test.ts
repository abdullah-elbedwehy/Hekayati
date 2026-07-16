import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, type Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { ManagedExportStore } from "../../src/portability/managed-export-store.js";
import {
  writeDeterministicArchive,
  type StagedArchiveSource,
} from "../../src/portability/export.js";
import { createManifest } from "../../src/portability/manifest.js";
import { verifyFinalizedArchive } from "../../src/portability/release-gate.js";
import { SecretReleaseGate } from "../../src/portability/secret-scan.js";
import { SecretRegistry } from "../../src/security/secret-registry.js";
import { temporaryDirectory } from "../helpers/temp.js";

const exportId = "01KZX48ZM9N74CRKFWQTJ76X2G";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("managed export store", () => {
  it("publishes by private atomic key and rechecks integrity for download", async () => {
    const fixture = await storeFixture();
    const archive = archiveInput(Buffer.from('{"safe":true}'));

    const published = await fixture.store.publish({
      exportId,
      write: (output) =>
        writeDeterministicArchive(archive.manifest, archive.sources, output),
      verify: (candidate, written) =>
        verifyFinalizedArchive(
          candidate,
          archive.manifest,
          written,
          new SecretReleaseGate(new SecretRegistry()),
        ),
    });

    expect(published.archiveKey).toMatch(
      new RegExp(`^${exportId}-[a-f0-9]{64}\\.zip$`),
    );
    expect((await stat(fixture.root)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(fixture.root, published.archiveKey))).mode & 0o777,
    ).toBe(0o600);
    expect(await readdir(fixture.root)).toEqual([published.archiveKey]);

    const download = await fixture.store.openDownload(
      published.archiveKey,
      published.archive,
    );
    const downloaded = await readAll(download.createReadStream());
    await download.close();
    expect(downloaded).toEqual(
      await readFile(join(fixture.root, published.archiveKey)),
    );
    await expect(
      fixture.store.openDownload(published.archiveKey, {
        ...published.archive,
        sha256: "f".repeat(64),
      }),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_KEY_CHECKSUM_MISMATCH");
  });

  it("destroys only a failed secret candidate and preserves the prior export", async () => {
    const fixture = await storeFixture();
    const clean = archiveInput(Buffer.from('{"safe":true}'));
    const prior = await fixture.store.publish({
      exportId,
      write: (output) =>
        writeDeterministicArchive(clean.manifest, clean.sources, output),
      verify: (candidate, written) =>
        verifyFinalizedArchive(
          candidate,
          clean.manifest,
          written,
          new SecretReleaseGate(new SecretRegistry()),
        ),
    });
    const priorBytes = await readFile(join(fixture.root, prior.archiveKey));

    const secret = "synthetic-managed-export-secret";
    const blocked = archiveInput(Buffer.from(`{"value":"${secret}"}`));
    const registry = new SecretRegistry();
    registry.register(secret);
    await expect(
      fixture.store.publish({
        exportId: "01KZX48ZM9N74CRKFWQTJ76X2H",
        write: (output) =>
          writeDeterministicArchive(blocked.manifest, blocked.sources, output),
        verify: (candidate, written) =>
          verifyFinalizedArchive(
            candidate,
            blocked.manifest,
            written,
            new SecretReleaseGate(registry),
          ),
      }),
    ).rejects.toMatchObject({
      message: "PORTABILITY_EXPORT_SECRET_FOUND",
      finding: { category: "registered_or_known_secret" },
    });

    expect(await readdir(fixture.root)).toEqual([prior.archiveKey]);
    expect(await readFile(join(fixture.root, prior.archiveKey))).toEqual(
      priorBytes,
    );
  });

  it("rejects forged writer metadata before publishing any candidate", async () => {
    const fixture = await storeFixture();
    const bytes = Buffer.from("synthetic-not-a-zip");
    const forged = { bytes: bytes.byteLength, sha256: "a".repeat(64) };

    await expect(
      fixture.store.publish({
        exportId,
        write: async (output) => {
          await writeBytes(output, bytes);
          return forged;
        },
        verify: async () => ({ ok: true, archive: forged }),
      }),
    ).rejects.toThrow("PORTABILITY_EXPORT_WRITER_INTEGRITY_MISMATCH");
    expect(await readdir(fixture.root)).toEqual([]);

    await expect(
      fixture.store.publish({
        exportId,
        write: async () => {
          throw new Error("SYNTHETIC_EXPORT_WRITE_FAILURE");
        },
        verify: async () => ({ ok: true, archive: forged }),
      }),
    ).rejects.toThrow("SYNTHETIC_EXPORT_WRITE_FAILURE");
    expect(await readdir(fixture.root)).toEqual([]);
  });

  it("requires exact 0600 mode and a key indexed by the expected checksum", async () => {
    const fixture = await storeFixture();
    const archive = archiveInput(Buffer.from('{"safe":true}'));
    const published = await fixture.store.publish({
      exportId,
      write: (output) =>
        writeDeterministicArchive(archive.manifest, archive.sources, output),
      verify: (candidate, written) =>
        verifyFinalizedArchive(
          candidate,
          archive.manifest,
          written,
          new SecretReleaseGate(new SecretRegistry()),
        ),
    });
    const target = join(fixture.root, published.archiveKey);
    await chmod(target, 0o700);
    await expect(
      fixture.store.openDownload(published.archiveKey, published.archive),
    ).rejects.toThrow("PORTABILITY_EXPORT_FILE_PERMISSIONS_INVALID");

    await chmod(target, 0o600);
    const alternateKey = `${exportId}-${"f".repeat(64)}.zip`;
    await copyFile(target, join(fixture.root, alternateKey));
    await chmod(join(fixture.root, alternateKey), 0o600);
    const outcome = await captureDownload(
      fixture.store.openDownload(alternateKey, published.archive),
    );
    expect(outcome).toBe("PORTABILITY_ARCHIVE_KEY_CHECKSUM_MISMATCH");
  });

  it("converges concurrent identical publishes on one private inode", async () => {
    const fixture = await storeFixture();
    const archive = archiveInput(Buffer.from('{"safe":true}'));
    const publish = () =>
      fixture.store.publish({
        exportId,
        write: (output) =>
          writeDeterministicArchive(archive.manifest, archive.sources, output),
        verify: (candidate, written) =>
          verifyFinalizedArchive(
            candidate,
            archive.manifest,
            written,
            new SecretReleaseGate(new SecretRegistry()),
          ),
      });

    const results = await Promise.all([publish(), publish(), publish()]);
    expect(new Set(results.map((result) => result.archiveKey)).size).toBe(1);
    expect(await readdir(fixture.root)).toEqual([results[0].archiveKey]);
    expect((await stat(join(fixture.root, results[0].archiveKey))).nlink).toBe(
      1,
    );
  });
});

async function storeFixture() {
  const directory = await temporaryDirectory("hekayati-managed-export-");
  cleanups.push(directory.cleanup);
  const root = join(directory.path, "exports");
  const store = new ManagedExportStore(root);
  await store.initialize();
  return { root, store };
}

function archiveInput(documentBytes: Buffer) {
  const documentHash = sha256(documentBytes);
  const manifest = createManifest({
    appVersion: "0.1.0",
    createdAt: "2026-07-16T00:00:00.000Z",
    exportId,
    mode: "project",
    scope: {
      kind: "project",
      projectId: "01KZX48ZM9N74CRKFWQTJ76X2P",
      customerId: "01KZX48ZM9N74CRKFWQTJ76X2C",
      familyId: "01KZX48ZM9N74CRKFWQTJ76X2F",
    },
    roots: [{ kind: "project", id: "01KZX48ZM9N74CRKFWQTJ76X2P" }],
    documents: [
      {
        collection: "projects",
        id: "01KZX48ZM9N74CRKFWQTJ76X2P",
        schemaVersion: 1,
        bytes: documentBytes.byteLength,
        sha256: documentHash,
      },
    ],
    media: [],
    snapshotHash: "a".repeat(64),
  });
  const sources: StagedArchiveSource[] = [
    {
      path: manifest.documents[0].path,
      bytes: documentBytes.byteLength,
      sha256: documentHash,
      open: () => Readable.from(documentBytes),
    },
  ];
  return { manifest, sources };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function writeBytes(output: Writable, bytes: Buffer): Promise<void> {
  output.end(bytes);
  await once(output, "finish");
}

async function captureDownload(
  pending: Promise<{ close(): Promise<void> }>,
): Promise<string | null> {
  try {
    const download = await pending;
    await download.close();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
