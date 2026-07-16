import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  link,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable, type Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  ManagedExportStore,
  type PublishedManagedExport,
} from "../../src/portability/managed-export-store.js";
import {
  writeDeterministicArchive,
  type StagedArchiveSource,
  type WrittenArchive,
} from "../../src/portability/export.js";
import { createManifest } from "../../src/portability/manifest.js";
import { SnapshotStagingStore } from "../../src/portability/staging-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const exportId = "01KZX48ZM9N74CRKFWQTJ76X2G";
const snapshotId = "01KZX48ZM9N74CRKFWQTJ76X2S";
const document = Buffer.from('{"id":"project-1"}');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("managed export low-level boundaries", () => {
  it("rejects malformed public identifiers before touching storage", async () => {
    const fixture = await managedFixture(false);
    const archive = archiveInput(document);

    await expect(
      fixture.store.publish({
        exportId: "../../not-an-export",
        write: (output) => writeArchive(archive, output),
        verify: async (_candidate, written) => ({
          ok: true,
          archive: written,
        }),
      }),
    ).rejects.toThrow("PORTABILITY_EXPORT_ID_INVALID");
    await expect(
      fixture.store.openDownload("../outside.zip", {
        bytes: 1,
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_KEY_INVALID");
    await expect(readdir(fixture.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a symlinked managed root", async () => {
    const fixture = await managedFixture(false);
    const target = join(fixture.base, "actual-exports");
    await mkdir(target);
    await symlink(target, fixture.root);

    await expect(fixture.store.initialize()).rejects.toThrow(
      "PORTABILITY_EXPORT_ROOT_INVALID",
    );
  });

  it("requires verifier metadata to match the exact candidate", async () => {
    const fixture = await managedFixture();
    const bytes = Buffer.from("synthetic-candidate");
    const written = writtenArchive(bytes);

    await expect(
      fixture.store.publish({
        exportId,
        write: async (output) => {
          await writeBytes(output, bytes);
          return written;
        },
        verify: async () => ({
          ok: true,
          archive: { ...written, bytes: written.bytes + 1 },
        }),
      }),
    ).rejects.toThrow("PORTABILITY_EXPORT_VERIFICATION_MISMATCH");
    expect(await readdir(fixture.root)).toEqual([]);
  });

  it("revalidates inode, mode, and bytes at download time", async () => {
    const fixture = await managedFixture();
    const archive = archiveInput(document);
    const first = await publishClean(fixture.store, archive);
    const target = join(fixture.root, first.archiveKey);
    const outsideLink = join(fixture.base, "outside-hardlink.zip");
    await link(target, outsideLink);

    await expect(
      fixture.store.openDownload(first.archiveKey, first.archive),
    ).rejects.toThrow("PORTABILITY_EXPORT_FILE_INVALID");
    await rm(outsideLink);
    await writeFile(target, Buffer.from("same-key-different-bytes"), {
      mode: 0o600,
    });
    await chmod(target, 0o600);
    await expect(
      fixture.store.openDownload(first.archiveKey, first.archive),
    ).rejects.toThrow("PORTABILITY_DOWNLOAD_INTEGRITY_MISMATCH");
  });

  it("converges replay publication and permits only one download stream", async () => {
    const fixture = await managedFixture();
    const archive = archiveInput(document);
    const first = await publishClean(fixture.store, archive);
    const replay = await publishClean(fixture.store, archive);
    expect(replay).toEqual(first);
    expect(await readdir(fixture.root)).toEqual([first.archiveKey]);

    const download = await fixture.store.openDownload(
      first.archiveKey,
      first.archive,
    );
    const stream = download.createReadStream();
    expect(() => download.createReadStream()).toThrow(
      "PORTABILITY_DOWNLOAD_STREAM_ALREADY_OPENED",
    );
    await readAll(stream);
    await download.close();
  });
});

describe("snapshot staging low-level boundaries", () => {
  it("rejects invalid snapshot IDs, duplicate paths, and invalid metadata", async () => {
    const fixture = await stagingFixture();
    const [entry] = stagingEntries();

    await expect(fixture.store.stage("../../bad", [entry])).rejects.toThrow(
      "PORTABILITY_SNAPSHOT_ID_INVALID",
    );
    await expect(
      fixture.store.stage(snapshotId, [entry, entry]),
    ).rejects.toThrow("PORTABILITY_STAGING_PATH_DUPLICATE");
    await expect(
      fixture.store.stage(snapshotId, [{ ...entry, bytes: 0 }]),
    ).rejects.toThrow("PORTABILITY_STAGING_METADATA_INVALID");
  });

  it("removes a new snapshot tree after source-open and hash failures", async () => {
    const fixture = await stagingFixture();
    const [entry] = stagingEntries();

    await expect(
      fixture.store.stage(snapshotId, [
        {
          ...entry,
          open: () => {
            throw new Error("SYNTHETIC_SOURCE_FAILURE");
          },
        },
      ]),
    ).rejects.toThrow("PORTABILITY_STAGING_SOURCE_OPEN_FAILED");
    expect(await readdir(fixture.root)).toEqual([]);

    await expect(
      fixture.store.stage(snapshotId, [
        {
          ...entry,
          open: () => Readable.from(Buffer.from('{"id":"project-2"}')),
        },
      ]),
    ).rejects.toThrow("PORTABILITY_STAGING_HASH_MISMATCH");
    expect(await readdir(fixture.root)).toEqual([]);
  });

  it("rejects symlinked roots and snapshot directories", async () => {
    const directory = await temporaryDirectory("hekayati-staging-symlink-");
    cleanups.push(directory.cleanup);
    const actual = join(directory.path, "actual");
    const root = join(directory.path, "staging");
    await mkdir(actual);
    await symlink(actual, root);
    await expect(new SnapshotStagingStore(root).initialize()).rejects.toThrow(
      "PORTABILITY_STAGING_DIRECTORY_INVALID",
    );

    const fixture = await stagingFixture();
    const snapshotTarget = join(fixture.base, "snapshot-target");
    await mkdir(snapshotTarget);
    await symlink(
      snapshotTarget,
      join(fixture.root, `.snapshot-${snapshotId}`),
    );
    await expect(
      fixture.store.stage(snapshotId, stagingEntries()),
    ).rejects.toThrow("PORTABILITY_STAGING_DIRECTORY_INVALID");
  });

  it("refuses nofollow reopen drift and a removed staged candidate", async () => {
    const fixture = await stagingFixture();
    const staged = await fixture.store.stage(snapshotId, stagingEntries());
    const target = join(
      fixture.root,
      `.snapshot-${snapshotId}`,
      "data/projects/project-1.json",
    );
    await rm(target);
    expect(() => staged[0].open()).toThrow(/ENOENT/);

    const outside = join(fixture.base, "outside.json");
    await writeFile(outside, document, { mode: 0o600 });
    await symlink(outside, target);
    await expect(
      fixture.store.stage(snapshotId, stagingEntries()),
    ).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("opens only a complete staged snapshot without consulting live sources", async () => {
    const fixture = await stagingFixture();
    await fixture.store.stage(snapshotId, stagingEntries());
    let liveOpens = 0;
    const expected = stagingEntries().map((entry) => ({
      ...entry,
      open: () => {
        liveOpens += 1;
        throw new Error("LIVE_SOURCE_MUST_NOT_OPEN");
      },
    }));

    const reopened = await fixture.store.openStaged(snapshotId, expected);
    expect(liveOpens).toBe(0);
    expect(await readAll(reopened[0].open())).toEqual(document);
  });

  it("fails closed when a released snapshot is missing, drifted, or has extras", async () => {
    const fixture = await stagingFixture();
    const expected = stagingEntries();
    const snapshotRoot = join(fixture.root, `.snapshot-${snapshotId}`);
    const target = join(snapshotRoot, "data/projects/project-1.json");
    await fixture.store.stage(snapshotId, expected);
    await rm(target);
    await expect(
      fixture.store.openStaged(snapshotId, expected),
    ).rejects.toThrow("PORTABILITY_STAGING_SNAPSHOT_INCOMPLETE");

    await fixture.store.cleanup(snapshotId);
    await fixture.store.stage(snapshotId, expected);
    await writeFile(target, Buffer.from('{"id":"project-2"}'));
    await expect(
      fixture.store.openStaged(snapshotId, expected),
    ).rejects.toThrow("PORTABILITY_STAGING_SNAPSHOT_INCOMPLETE");

    await fixture.store.cleanup(snapshotId);
    await fixture.store.stage(snapshotId, expected);
    await writeFile(join(snapshotRoot, "unexpected.bin"), Buffer.from("x"), {
      mode: 0o600,
    });
    await expect(
      fixture.store.openStaged(snapshotId, expected),
    ).rejects.toThrow("PORTABILITY_STAGING_SNAPSHOT_INCOMPLETE");
  });
});

async function managedFixture(initialize = true) {
  const directory = await temporaryDirectory("hekayati-managed-adversarial-");
  cleanups.push(directory.cleanup);
  const root = join(directory.path, "exports");
  const store = new ManagedExportStore(root);
  if (initialize) await store.initialize();
  return { base: directory.path, root, store };
}

async function stagingFixture() {
  const directory = await temporaryDirectory("hekayati-staging-adversarial-");
  cleanups.push(directory.cleanup);
  const root = join(directory.path, "staging");
  const store = new SnapshotStagingStore(root);
  await store.initialize();
  return { base: directory.path, root, store };
}

function archiveInput(bytes: Buffer) {
  const hash = sha256(bytes);
  const manifest = createManifest({
    appVersion: "0.1.0",
    createdAt: "2026-07-16T00:00:00.000Z",
    exportId,
    mode: "project",
    scope: {
      kind: "project",
      projectId: "project-1",
      customerId: "customer-1",
      familyId: "family-1",
    },
    roots: [{ kind: "project", id: "project-1" }],
    documents: [
      {
        collection: "projects",
        id: "project-1",
        schemaVersion: 1,
        bytes: bytes.byteLength,
        sha256: hash,
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
        sha256: hash,
        open: () => Readable.from(bytes),
      },
    ] satisfies StagedArchiveSource[],
  };
}

function stagingEntries(): StagedArchiveSource[] {
  return [
    {
      path: "data/projects/project-1.json",
      bytes: document.byteLength,
      sha256: sha256(document),
      open: () => Readable.from(document),
    },
  ];
}

function writeArchive(
  archive: ReturnType<typeof archiveInput>,
  output: Writable,
): Promise<WrittenArchive> {
  return writeDeterministicArchive(archive.manifest, archive.sources, output);
}

function publishClean(
  store: ManagedExportStore,
  archive: ReturnType<typeof archiveInput>,
): Promise<PublishedManagedExport> {
  return store.publish({
    exportId,
    write: (output) => writeArchive(archive, output),
    verify: async (_candidate, written) => ({ ok: true, archive: written }),
  });
}

async function writeBytes(output: Writable, bytes: Buffer): Promise<void> {
  output.end(bytes);
  await once(output, "finish");
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function writtenArchive(bytes: Buffer): WrittenArchive {
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
