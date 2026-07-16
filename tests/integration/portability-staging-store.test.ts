import { createHash } from "node:crypto";
import { chmod, link, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { SnapshotStagingStore } from "../../src/portability/staging-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const snapshotId = "01KZX48ZM9N74CRKFWQTJ76X2S";
const document = Buffer.from('{"id":"project-1"}');
const media = Buffer.from("synthetic-media");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("portability snapshot staging store", () => {
  it("atomically stages verified frozen sources and reopens them by generated path", async () => {
    const fixture = await stagingFixture();
    const entries = stagedEntries();

    const sources = await fixture.store.stage(snapshotId, entries.reverse());
    expect(sources.map((source) => source.path)).toEqual(
      stagedEntries().map((entry) => entry.path),
    );
    expect(await readAll(sources[0].open())).toEqual(document);
    expect(await readAll(sources[1].open())).toEqual(media);
    expect((await stat(fixture.root)).mode & 0o777).toBe(0o700);
    expect(
      (
        await stat(
          join(
            fixture.root,
            `.snapshot-${snapshotId}`,
            "data/projects/project-1.json",
          ),
        )
      ).mode & 0o777,
    ).toBe(0o600);

    await expect(
      fixture.store.stage(snapshotId, stagedEntries()),
    ).resolves.toHaveLength(2);
  });

  it("rejects unsafe paths and integrity drift without leaving partial staging", async () => {
    const fixture = await stagingFixture();
    let opened = false;
    await expect(
      fixture.store.stage(snapshotId, [
        {
          ...stagedEntries()[0],
          path: "../../outside.json",
          open: () => {
            opened = true;
            return Readable.from(document);
          },
        },
      ]),
    ).rejects.toThrow("PORTABILITY_STAGING_PATH_INVALID");
    expect(opened).toBe(false);

    await expect(
      fixture.store.stage(snapshotId, [
        {
          ...stagedEntries()[0],
          open: () => Readable.from(Buffer.from("drift")),
        },
      ]),
    ).rejects.toThrow("PORTABILITY_STAGING_BYTES_MISMATCH");
    expect(await readdir(fixture.root)).toEqual([]);
  });

  it("rejects permission drift and hard-linked staged files on reopen", async () => {
    const fixture = await stagingFixture();
    const first = await fixture.store.stage(snapshotId, stagedEntries());
    const target = join(
      fixture.root,
      `.snapshot-${snapshotId}`,
      "data/projects/project-1.json",
    );
    await chmod(target, 0o700);
    await expect(
      fixture.store.stage(snapshotId, stagedEntries()),
    ).rejects.toThrow("PORTABILITY_STAGING_FILE_CONFLICT");

    await fixture.store.cleanup(snapshotId);
    const second = await fixture.store.stage(snapshotId, stagedEntries());
    const outside = join(fixture.base, "outside.json");
    await writeFile(outside, document, { mode: 0o600 });
    await rm(target);
    await link(outside, target);
    expect(() => {
      const stream = second[0].open();
      stream.destroy();
    }).toThrow("PORTABILITY_STAGING_FILE_INVALID");
    expect(first).toHaveLength(2);
  });
});

async function stagingFixture() {
  const directory = await temporaryDirectory("hekayati-staging-");
  cleanups.push(directory.cleanup);
  const root = join(directory.path, "portability-staging");
  const store = new SnapshotStagingStore(root);
  await store.initialize();
  return { base: directory.path, root, store };
}

function stagedEntries() {
  return [
    {
      path: "data/projects/project-1.json",
      bytes: document.byteLength,
      sha256: sha256(document),
      open: () => Readable.from(document),
    },
    {
      path: `media/assets/${sha256(media)}.png`,
      bytes: media.byteLength,
      sha256: sha256(media),
      open: () => Readable.from(media),
    },
  ];
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
