import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";

import { fromBufferPromise } from "yauzl";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/contracts/canonical-json.js";
import {
  writeDeterministicArchive,
  type StagedArchiveSource,
} from "../../src/portability/export.js";
import { createManifest } from "../../src/portability/manifest.js";

const documentBytes = Buffer.from('{"id":"project-1"}');
const mediaBytes = Buffer.from("synthetic-media");

describe("deterministic portability archive writer", () => {
  it("writes manifest first and identical bytes regardless of source order", async () => {
    const manifest = buildManifest();
    const sources = buildSources(manifest);

    const first = await collectArchive(manifest, sources);
    const second = await collectArchive(manifest, [...sources].reverse());

    expect(second.bytes).toEqual(first.bytes);
    expect(second.result).toEqual(first.result);
    expect(first.result.sha256).toBe(sha256(first.bytes));
    expect(first.result.bytes).toBe(first.bytes.byteLength);

    const zip = await fromBufferPromise(first.bytes, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
    const names: string[] = [];
    const contents = new Map<string, Buffer>();
    for await (const entry of zip.eachEntry()) {
      names.push(entry.fileName);
      expect(entry.externalFileAttributes >>> 16).toBe(0o100600);
      expect(entry.extraFields).toEqual([]);
      expect(entry.getLastModDate({ forceDosFormat: true })).toEqual(
        new Date(1980, 0, 1),
      );
      const stream = await zip.openReadStreamPromise(entry);
      contents.set(entry.fileName, await readAll(stream));
    }
    zip.close();

    expect(names).toEqual([
      "manifest.json",
      manifest.documents[0]?.path,
      manifest.media[0]?.path,
    ]);
    expect(contents.get("manifest.json")?.toString("utf8")).toBe(
      canonicalJson(manifest),
    );
    expect(contents.get(manifest.documents[0].path)).toEqual(documentBytes);
    expect(contents.get(manifest.media[0].path)).toEqual(mediaBytes);
  });

  it("rejects incomplete, extra, duplicate, or corrupt staged sources", async () => {
    const manifest = buildManifest();
    const sources = buildSources(manifest);

    await expect(collectArchive(manifest, sources.slice(0, 1))).rejects.toThrow(
      "PORTABILITY_ARCHIVE_SOURCE_SET_MISMATCH",
    );
    await expect(
      collectArchive(manifest, [
        ...sources,
        {
          path: "data/projects/extra.json",
          bytes: 1,
          sha256: sha256(Buffer.from("x")),
          open: () => Readable.from(Buffer.from("x")),
        },
      ]),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_SOURCE_SET_MISMATCH");
    await expect(
      collectArchive(manifest, [...sources, sources[0]]),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_DUPLICATE_SOURCE");
    await expect(
      collectArchive(manifest, [
        {
          ...sources[0],
          open: () => Readable.from(Buffer.from("tampered")),
        },
        sources[1],
      ]),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_SOURCE_BYTES_MISMATCH");
  });
});

function buildManifest() {
  return createManifest({
    appVersion: "0.1.0",
    createdAt: "2026-07-16T00:00:00.000Z",
    exportId: "export-1",
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
        bytes: documentBytes.byteLength,
        sha256: sha256(documentBytes),
      },
    ],
    media: [
      {
        namespace: "asset",
        assetId: "asset-1",
        role: "illustration",
        mime: "image/png",
        extension: "png",
        bytes: mediaBytes.byteLength,
        sha256: sha256(mediaBytes),
      },
    ],
    snapshotHash: "a".repeat(64),
  });
}

function buildSources(
  manifest: ReturnType<typeof buildManifest>,
): StagedArchiveSource[] {
  return [
    {
      path: manifest.documents[0].path,
      bytes: documentBytes.byteLength,
      sha256: sha256(documentBytes),
      open: () => Readable.from(documentBytes),
    },
    {
      path: manifest.media[0].path,
      bytes: mediaBytes.byteLength,
      sha256: sha256(mediaBytes),
      open: () => Readable.from(mediaBytes),
    },
  ];
}

async function collectArchive(
  manifest: ReturnType<typeof buildManifest>,
  sources: StagedArchiveSource[],
) {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const result = await writeDeterministicArchive(manifest, sources, output);
  return { bytes: Buffer.concat(chunks), result };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
