import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, link, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ZipFile } from "yazl";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/contracts/canonical-json.js";
import {
  writeDeterministicArchive,
  type StagedArchiveSource,
  type WrittenArchive,
} from "../../src/portability/export.js";
import {
  createManifest,
  parseManifestBytes,
  type CreateManifestInput,
  type ManifestV2,
} from "../../src/portability/manifest.js";
import {
  scanStagedArchive,
  verifyFinalizedArchive,
} from "../../src/portability/release-gate.js";
import {
  SecretReleaseGate,
  type SecretScanFinding,
} from "../../src/portability/secret-scan.js";
import { SecretRegistry } from "../../src/security/secret-registry.js";
import { temporaryDirectory } from "../helpers/temp.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const document = Buffer.from('{"id":"project-1"}');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("manifest parser adversarial invariants", () => {
  it("rejects oversized, invalid UTF-8, and invalid JSON byte boundaries", () => {
    expect(() => parseManifestBytes(Buffer.alloc(8 * 1024 * 1024 + 1))).toThrow(
      "PORTABILITY_MANIFEST_SIZE_LIMIT",
    );
    expect(() => parseManifestBytes(Buffer.from([0xc3, 0x28]))).toThrow(
      "PORTABILITY_MANIFEST_UTF8_INVALID",
    );
    expect(() => parseManifestBytes(Buffer.from("{"))).toThrow(
      "PORTABILITY_MANIFEST_JSON_INVALID",
    );
  });

  it("rejects totals and generated document/media paths that drift", () => {
    const valid = createManifest(manifestInput(true));
    expect(() =>
      parseCanonical({ ...valid, totalUncompressedBytes: 1 }),
    ).toThrow("PORTABILITY_MANIFEST_TOTAL_MISMATCH");
    expect(() =>
      parseCanonical({
        ...valid,
        documents: [
          { ...valid.documents[0], path: "data/projects/other.json" },
        ],
      }),
    ).toThrow("PORTABILITY_MANIFEST_DOCUMENT_PATH_INVALID");
    expect(() =>
      parseCanonical({
        ...valid,
        media: [{ ...valid.media[0], path: `media/originals/${hashB}.png` }],
      }),
    ).toThrow("PORTABILITY_MANIFEST_MEDIA_PATH_INVALID");
  });

  it("rejects duplicate and non-canonical root or entry order", () => {
    const input = manifestInput(false);
    expect(() =>
      createManifest({
        ...input,
        roots: [input.roots[0], input.roots[0]],
      }),
    ).toThrow("PORTABILITY_MANIFEST_DUPLICATE_ROOT");

    const valid = createManifest({
      ...input,
      roots: [
        { kind: "project", id: "project-1" },
        { kind: "customer", id: "customer-1" },
      ],
      documents: [
        ...input.documents,
        { ...input.documents[0], id: "project-2", sha256: hashB },
      ],
    });
    expect(() =>
      parseCanonical({ ...valid, roots: [...valid.roots].reverse() }),
    ).toThrow("PORTABILITY_MANIFEST_ROOT_ORDER_INVALID");
    expect(() =>
      parseCanonical({
        ...valid,
        documents: [...valid.documents].reverse(),
      }),
    ).toThrow("PORTABILITY_MANIFEST_ORDER_INVALID");
  });

  it("rejects aggregate byte overflow and the listed-entry ceiling", () => {
    const input = manifestInput(false);
    expect(() =>
      createManifest({
        ...input,
        documents: [
          { ...input.documents[0], bytes: Number.MAX_SAFE_INTEGER },
          { ...input.documents[0], id: "project-2", bytes: 1 },
        ],
      }),
    ).toThrow("PORTABILITY_MANIFEST_TOTAL_OVERFLOW");

    expect(() =>
      createManifest({
        ...input,
        documents: Array.from({ length: 20_000 }, (_, index) => ({
          ...input.documents[0],
          id: `project-${index.toString().padStart(5, "0")}`,
        })),
      }),
    ).toThrow("PORTABILITY_MANIFEST_ENTRY_LIMIT");
  });
});

describe("archive writer adversarial boundaries", () => {
  it("rejects a same-cardinality missing source and metadata drift", async () => {
    const fixture = stagedFixture(document);
    const wrongPath = {
      ...fixture.sources[0],
      path: "data/projects/other.json",
    };
    await expect(collectArchive(fixture.manifest, [wrongPath])).rejects.toThrow(
      "PORTABILITY_ARCHIVE_SOURCE_SET_MISMATCH",
    );
    await expect(
      collectArchive(fixture.manifest, [
        { ...fixture.sources[0], bytes: document.byteLength + 1 },
      ]),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_SOURCE_METADATA_MISMATCH");
  });

  it("normalizes source-open failures and detects same-size hash drift", async () => {
    const fixture = stagedFixture(document);
    await expect(
      collectArchive(fixture.manifest, [
        {
          ...fixture.sources[0],
          open: () => {
            return new Readable({
              read() {
                this.emit("error", "SYNTHETIC_NON_ERROR_FAILURE");
                this.push(null);
              },
            });
          },
        },
      ]),
    ).rejects.toThrow("SYNTHETIC_NON_ERROR_FAILURE");

    const drift = Buffer.from('{"id":"project-2"}');
    expect(drift.byteLength).toBe(document.byteLength);
    await expect(
      collectArchive(fixture.manifest, [
        { ...fixture.sources[0], open: () => Readable.from(drift) },
      ]),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_SOURCE_HASH_MISMATCH");
  });
});

describe("release gate adversarial boundaries", () => {
  it("rejects staged source set, duplicate, metadata, and open drift", async () => {
    const fixture = stagedFixture(document);
    const gate = cleanGate();
    await expect(scanStagedArchive(fixture.manifest, [], gate)).rejects.toThrow(
      "PORTABILITY_ARCHIVE_SOURCE_SET_MISMATCH",
    );
    await expect(
      scanStagedArchive(
        fixture.manifest,
        [fixture.sources[0], fixture.sources[0]],
        gate,
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_DUPLICATE_SOURCE");
    await expect(
      scanStagedArchive(
        fixture.manifest,
        [{ ...fixture.sources[0], path: "data/projects/other.json" }],
        gate,
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_SOURCE_SET_MISMATCH");
    await expect(
      scanStagedArchive(
        fixture.manifest,
        [{ ...fixture.sources[0], bytes: document.byteLength + 1 }],
        gate,
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_SOURCE_METADATA_MISMATCH");
    await expect(
      scanStagedArchive(
        fixture.manifest,
        [
          {
            ...fixture.sources[0],
            open: () => {
              throw new Error("SYNTHETIC_OPEN_FAILURE");
            },
          },
        ],
        gate,
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_SOURCE_OPEN_FAILED");
  });

  it("returns bounded findings from manifest, entry name, or entry bytes", async () => {
    const fixture = stagedFixture(document);
    const finding: SecretScanFinding = {
      category: "seeded_canary",
      entry: "bounded",
    };
    await expect(
      scanStagedArchive(
        fixture.manifest,
        fixture.sources,
        scriptedGate({ streamFindingAt: 1, finding }),
      ),
    ).resolves.toEqual(finding);
    await expect(
      scanStagedArchive(
        fixture.manifest,
        fixture.sources,
        scriptedGate({ nameFindingAt: 1, finding }),
      ),
    ).resolves.toEqual(finding);
    await expect(
      scanStagedArchive(
        fixture.manifest,
        fixture.sources,
        scriptedGate({ streamFindingAt: 2, finding }),
      ),
    ).resolves.toEqual(finding);
  });

  it("rejects staged byte and checksum drift after full scanning", async () => {
    const fixture = stagedFixture(document);
    await expect(
      scanStagedArchive(
        fixture.manifest,
        [
          {
            ...fixture.sources[0],
            open: () => Readable.from(Buffer.from("short")),
          },
        ],
        cleanGate(),
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_ENTRY_BYTES_MISMATCH");
    const sameSize = Buffer.from('{"id":"project-2"}');
    await expect(
      scanStagedArchive(
        fixture.manifest,
        [{ ...fixture.sources[0], open: () => Readable.from(sameSize) }],
        cleanGate(),
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_ENTRY_CHECKSUM_MISMATCH");
  });

  it("rejects a non-ZIP candidate and hard-linked candidate before release", async () => {
    const directory = await temporaryDirectory("hekayati-release-boundary-");
    cleanups.push(directory.cleanup);
    const invalid = join(directory.path, "invalid.zip");
    const bytes = Buffer.from("synthetic-not-a-zip");
    await writeFile(invalid, bytes, { mode: 0o600 });
    await expect(
      verifyFinalizedArchive(
        invalid,
        stagedFixture(document).manifest,
        writtenArchive(bytes),
        cleanGate(),
      ),
    ).rejects.toThrow();

    const fixture = await archiveFile(document);
    await link(fixture.file, join(directory.path, "hardlink.zip"));
    await expect(
      verifyFinalizedArchive(
        fixture.file,
        fixture.manifest,
        fixture.written,
        cleanGate(),
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_FILE_INVALID");
  });

  it("detects finalized manifest byte and checksum mismatches", async () => {
    const fixture = await archiveFile(document);
    const differentSize = createManifest({
      ...manifestInput(false),
      exportId: "a-much-longer-export-id",
    });
    await expect(
      verifyFinalizedArchive(
        fixture.file,
        differentSize,
        fixture.written,
        cleanGate(),
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_ENTRY_INVALID");

    const sameSize = createManifest({
      ...manifestInput(false),
      snapshotHash: hashB,
    });
    await expect(
      verifyFinalizedArchive(
        fixture.file,
        sameSize,
        fixture.written,
        cleanGate(),
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_ENTRY_CHECKSUM_MISMATCH");
  });

  it("rejects finalized entry set and regular-file mode drift", async () => {
    const fixture = stagedFixture(document);
    const missing = await customArchive(fixture.manifest, []);
    await expect(
      verifyFinalizedArchive(
        missing.file,
        fixture.manifest,
        missing.written,
        cleanGate(),
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_ENTRY_SET_MISMATCH");

    const irregular = await customArchive(fixture.manifest, [
      {
        path: fixture.manifest.documents[0].path,
        bytes: document,
        mode: 0o040700,
      },
    ]);
    await expect(
      verifyFinalizedArchive(
        irregular.file,
        fixture.manifest,
        irregular.written,
        cleanGate(),
      ),
    ).rejects.toThrow("PORTABILITY_ARCHIVE_ENTRY_INVALID");
  });
});

function manifestInput(withMedia: boolean): CreateManifestInput {
  return {
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
        bytes: document.byteLength,
        sha256: sha256(document),
      },
    ],
    media: withMedia
      ? [
          {
            namespace: "asset",
            assetId: "asset-1",
            role: "illustration",
            mime: "image/png",
            extension: "png",
            bytes: 1,
            sha256: hashB,
          },
        ]
      : [],
    snapshotHash: hashA,
  };
}

function parseCanonical(value: unknown): ManifestV2 {
  return parseManifestBytes(Buffer.from(canonicalJson(value), "utf8"));
}

function stagedFixture(bytes: Buffer) {
  const manifest = createManifest({
    ...manifestInput(false),
    documents: [
      {
        ...manifestInput(false).documents[0],
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      },
    ],
  });
  return {
    manifest,
    sources: [
      {
        path: manifest.documents[0].path,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        open: () => Readable.from(bytes),
      },
    ] satisfies StagedArchiveSource[],
  };
}

function cleanGate(): SecretReleaseGate {
  return new SecretReleaseGate(new SecretRegistry());
}

function scriptedGate(options: {
  streamFindingAt?: number;
  nameFindingAt?: number;
  finding: SecretScanFinding;
}): SecretReleaseGate {
  let streamCalls = 0;
  let nameCalls = 0;
  return {
    scanStream: async (_entry: string, stream: Readable) => {
      streamCalls += 1;
      for await (const _chunk of stream) {
        void _chunk;
        // Consume the verifier so integrity checks still run.
      }
      return streamCalls === options.streamFindingAt ? options.finding : null;
    },
    scanEntryName: () => {
      nameCalls += 1;
      return nameCalls === options.nameFindingAt ? options.finding : null;
    },
  } as unknown as SecretReleaseGate;
}

async function collectArchive(
  manifest: ManifestV2,
  sources: StagedArchiveSource[],
): Promise<WrittenArchive> {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      void _chunk;
      callback();
    },
  });
  return writeDeterministicArchive(manifest, sources, output);
}

async function archiveFile(bytes: Buffer) {
  const directory = await temporaryDirectory("hekayati-release-archive-");
  cleanups.push(directory.cleanup);
  const file = join(directory.path, "candidate.zip");
  const fixture = stagedFixture(bytes);
  const written = await writeDeterministicArchive(
    fixture.manifest,
    fixture.sources,
    createWriteStream(file, { flags: "wx", mode: 0o600 }),
  );
  await chmod(file, 0o600);
  return { ...fixture, file, written };
}

async function customArchive(
  manifest: ManifestV2,
  entries: ReadonlyArray<{ path: string; bytes: Buffer; mode: number }>,
) {
  const directory = await temporaryDirectory("hekayati-release-custom-");
  cleanups.push(directory.cleanup);
  const file = join(directory.path, "candidate.zip");
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(canonicalJson(manifest)), "manifest.json", {
    mode: 0o100600,
  });
  for (const entry of entries)
    zip.addBuffer(entry.bytes, entry.path, { mode: entry.mode });
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(file, { mode: 0o600 }));
  await chmod(file, 0o600);
  const bytes = await readFile(file);
  return { file, written: writtenArchive(bytes) };
}

function writtenArchive(bytes: Uint8Array): WrittenArchive {
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
