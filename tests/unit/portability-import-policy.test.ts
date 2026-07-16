import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/contracts/canonical-json.js";
import {
  ARCHIVE_POLICY_V1,
  ArchivePolicyMeter,
  ArchiveValidationError,
  archiveCanonicalNameV1,
  assertSafeEntryPrefix,
  assertUploadDeclaration,
  type ArchiveCentralEntry,
} from "../../src/portability/archive-policy.js";
import {
  IMPORT_WORKSPACE_FLOOR_BYTES,
  calculateImportDiskFacts,
} from "../../src/portability/disk-preflight.js";
import {
  migrateManifestV1,
  normalizeImportManifestBytes,
} from "../../src/portability/import-manifest.js";

describe("ArchivePolicy/v1", () => {
  it("freezes the approved exact resource limits", () => {
    expect(ARCHIVE_POLICY_V1).toMatchObject({
      version: 1,
      maxCompressedUploadBytes: 8 * 1024 ** 3,
      maxEntries: 20_000,
      maxEntryNameBytes: 240,
      maxManifestBytes: 8 * 1024 ** 2,
      maxCanonicalDocumentBytes: 16 * 1024 ** 2,
      maxMediaBytes: 2 * 1024 ** 3,
      maxAggregateUncompressedBytes: 16 * 1024 ** 3,
      maxCompressionRatio: 200,
    });
    expect(Object.isFrozen(ARCHIVE_POLICY_V1)).toBe(true);
    expect(() => assertUploadDeclaration(8 * 1024 ** 3)).not.toThrow();
    expect(() => assertUploadDeclaration(8 * 1024 ** 3 + 1)).toThrow(
      "IMPORT_UPLOAD_COMPRESSED_LIMIT",
    );
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => assertUploadDeclaration(invalid)).toThrow(
        "IMPORT_UPLOAD_BYTES_INVALID",
      );
  });

  it("rejects traversal, absolute, backslash, NUL, non-NFC and collisions", () => {
    const invalid = [
      "/manifest.json",
      "C:/manifest.json",
      "../manifest.json",
      "data\\projects\\id.json",
      "data/projects/../id.json",
      "data/projects/a\0.json",
    ];
    for (const path of invalid)
      expectPolicyFailure(entry(path), "IMPORT_ARCHIVE_PATH_INVALID");
    expectPolicyFailure(
      entry("data/projects/e\u0301.json"),
      "IMPORT_ARCHIVE_NAME_NOT_NFC",
    );

    const meter = new ArchivePolicyMeter();
    meter.add(entry("data/projects/A.json"));
    expect(() => meter.add(entry("data/projects/a.json"))).toThrow(
      "IMPORT_ARCHIVE_NAME_COLLISION",
    );
    expect(archiveCanonicalNameV1("Straße")).toBe("strasse");
  });

  it("returns only a generated safe entry descriptor for hostile names", () => {
    const path = "../synthetic-private-child-name.json";
    try {
      new ArchivePolicyMeter().add(entry(path));
      throw new Error("EXPECTED_FAILURE");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveValidationError);
      expect(error).toMatchObject({
        code: "IMPORT_ARCHIVE_PATH_INVALID",
        entry: expect.stringMatching(/^entry-[a-f0-9]{12}$/),
      });
      expect(JSON.stringify(error)).not.toContain("private-child-name");
    }
  });

  it("enforces type, regular-file, comment, extra-field and ratio gates", () => {
    expectPolicyFailure(entry("payload.exe"), "IMPORT_ARCHIVE_EXECUTABLE_NAME");
    expectPolicyFailure(entry("payload.zip"), "IMPORT_ARCHIVE_NESTED_ARCHIVE");
    expectPolicyFailure(
      entry("manifest.json", { generalPurposeBitFlag: 1 }),
      "IMPORT_ARCHIVE_ENCRYPTED",
    );
    expectPolicyFailure(
      entry("manifest.json", { externalFileAttributes: 0o120777 << 16 }),
      "IMPORT_ARCHIVE_NON_REGULAR",
    );
    expectPolicyFailure(
      entry("manifest.json", { fileCommentLength: 1 }),
      "IMPORT_ARCHIVE_ENTRY_COMMENT_UNSUPPORTED",
    );
    expectPolicyFailure(
      entry("manifest.json", {
        extraFieldLength: ARCHIVE_POLICY_V1.maxEntryExtraFieldBytes + 1,
      }),
      "IMPORT_ARCHIVE_CENTRAL_DIRECTORY_LIMIT",
    );
    expectPolicyFailure(
      entry("manifest.json", { compressedSize: 1, uncompressedSize: 201 }),
      "IMPORT_ARCHIVE_ENTRY_RATIO_LIMIT",
    );
  });

  it("detects executable and nested-archive content including TAR offset", () => {
    expect(() => assertSafeEntryPrefix("safe.pdf", Buffer.from("MZ"))).toThrow(
      "IMPORT_ARCHIVE_EXECUTABLE_CONTENT",
    );
    expect(() =>
      assertSafeEntryPrefix("safe.pdf", Buffer.from("504b0304", "hex")),
    ).toThrow("IMPORT_ARCHIVE_NESTED_ARCHIVE");
    const tar = Buffer.alloc(512);
    tar.write("ustar", 257, "ascii");
    expect(() => assertSafeEntryPrefix("safe.pdf", tar)).toThrow(
      "IMPORT_ARCHIVE_NESTED_ARCHIVE",
    );
    for (const prefix of [
      Buffer.from("7f454c46", "hex"),
      Buffer.from("#!synthetic"),
      Buffer.from("feedface", "hex"),
      Buffer.from("feedfacf", "hex"),
      Buffer.from("cefaedfe", "hex"),
      Buffer.from("cffaedfe", "hex"),
    ])
      expect(() => assertSafeEntryPrefix("safe.pdf", prefix)).toThrow(
        "IMPORT_ARCHIVE_EXECUTABLE_CONTENT",
      );
    for (const prefix of [
      Buffer.from("1f8b08", "hex"),
      Buffer.from("526172211a0700", "hex"),
      Buffer.from("377abcaf271c", "hex"),
    ])
      expect(() => assertSafeEntryPrefix("safe.pdf", prefix)).toThrow(
        "IMPORT_ARCHIVE_NESTED_ARCHIVE",
      );
  });

  it("counts central/compressed/uncompressed bytes with overflow safety", () => {
    const meter = new ArchivePolicyMeter();
    meter.add(entry("manifest.json"));
    expect(meter.summary()).toEqual({
      entryCount: 1,
      compressedBytes: 1,
      uncompressedBytes: 1,
      centralDirectoryBytes: 46 + Buffer.byteLength("manifest.json"),
    });
    expectPolicyFailure(
      entry("manifest.json", {
        compressedSize: Number.MAX_SAFE_INTEGER,
        uncompressedSize: 1,
      }),
      "IMPORT_ARCHIVE_COMPRESSED_LIMIT",
    );
  });

  it("accepts every exact size boundary and rejects its next byte", () => {
    for (const [path, maximum, code] of [
      ["manifest.json", ARCHIVE_POLICY_V1.maxManifestBytes, "manifest"],
      [
        "data/projects/synthetic.json",
        ARCHIVE_POLICY_V1.maxCanonicalDocumentBytes,
        "document",
      ],
      [
        `media/assets/${"a".repeat(64)}.pdf`,
        ARCHIVE_POLICY_V1.maxMediaBytes,
        "media",
      ],
    ] as const) {
      expect(() =>
        new ArchivePolicyMeter().add(
          entry(path, { compressedSize: maximum, uncompressedSize: maximum }),
        ),
      ).not.toThrow();
      expectPolicyFailure(
        entry(path, {
          compressedSize: maximum + 1,
          uncompressedSize: maximum + 1,
        }),
        `IMPORT_ARCHIVE_${code.toUpperCase()}_LIMIT`,
      );
    }
    const exactName = `data/x/${"a".repeat(240 - "data/x/.json".length)}.json`;
    expect(Buffer.byteLength(exactName)).toBe(240);
    expect(() => new ArchivePolicyMeter().add(entry(exactName))).not.toThrow();
    expectPolicyFailure(
      entry(`${exactName}a`),
      "IMPORT_ARCHIVE_NAME_BYTES_LIMIT",
    );
  });

  it("enforces exact count, compressed, aggregate, and ratio boundaries", () => {
    const count = new ArchivePolicyMeter();
    for (let index = 0; index < ARCHIVE_POLICY_V1.maxEntries; index += 1)
      count.add(mediaEntry(index, { compressedSize: 0, uncompressedSize: 0 }));
    expect(count.summary().entryCount).toBe(ARCHIVE_POLICY_V1.maxEntries);
    expect(() => count.add(mediaEntry(20_000))).toThrow(
      "IMPORT_ARCHIVE_ENTRY_LIMIT",
    );

    const compressed = new ArchivePolicyMeter();
    compressed.add(
      mediaEntry(0, {
        compressedSize: ARCHIVE_POLICY_V1.maxCompressedUploadBytes,
        uncompressedSize: 1,
      }),
    );
    expect(() => compressed.add(mediaEntry(1))).toThrow(
      "IMPORT_ARCHIVE_COMPRESSED_LIMIT",
    );

    const aggregate = new ArchivePolicyMeter();
    for (let index = 0; index < 8; index += 1)
      aggregate.add(
        mediaEntry(index, {
          compressedSize: Math.ceil(ARCHIVE_POLICY_V1.maxMediaBytes / 200),
          uncompressedSize: ARCHIVE_POLICY_V1.maxMediaBytes,
        }),
      );
    expect(aggregate.summary().uncompressedBytes).toBe(
      ARCHIVE_POLICY_V1.maxAggregateUncompressedBytes,
    );
    expect(() => aggregate.add(mediaEntry(8))).toThrow(
      "IMPORT_ARCHIVE_AGGREGATE_LIMIT",
    );
    expect(() =>
      new ArchivePolicyMeter().add(
        mediaEntry(0, { compressedSize: 1, uncompressedSize: 200 }),
      ),
    ).not.toThrow();
    expectPolicyFailure(
      mediaEntry(0, { compressedSize: 1, uncompressedSize: 201 }),
      "IMPORT_ARCHIVE_ENTRY_RATIO_LIMIT",
    );
  });

  it("rejects malformed UTF-8 names and unsupported compression metadata", () => {
    expectPolicyFailure(
      entry("manifest.json", {
        fileNameRaw: Buffer.from([0xff]),
        generalPurposeBitFlag: 0x800,
      }),
      "IMPORT_ARCHIVE_NAME_ENCODING_INVALID",
    );
    expectPolicyFailure(
      entry("manifest.json", { compressionMethod: 12 }),
      "IMPORT_ARCHIVE_COMPRESSION_UNSUPPORTED",
    );
    expectPolicyFailure(
      entry("manifest.json", { externalFileAttributes: 0o100700 << 16 }),
      "IMPORT_ARCHIVE_EXECUTABLE_MODE",
    );
  });

  it("handles DOS regular files and rejects malformed sizes and attributes", () => {
    expect(() =>
      new ArchivePolicyMeter().add(
        entry("manifest.json", {
          fileNameRaw: undefined,
          versionMadeBy: 0,
          externalFileAttributes: 0,
          compressedSize: 0,
          uncompressedSize: 0,
        }),
      ),
    ).not.toThrow();
    expectPolicyFailure(
      entry("manifest.json", { fileName: "bad\uFFFDname" }),
      "IMPORT_ARCHIVE_NAME_ENCODING_INVALID",
    );
    for (const overrides of [
      { compressedSize: -1 },
      { uncompressedSize: -1 },
      { compressedSize: 1.5 },
      { extraFieldLength: -1 },
      { fileCommentLength: -1 },
    ])
      expectPolicyFailure(
        entry("manifest.json", overrides),
        overrides.fileCommentLength === -1
          ? "IMPORT_ARCHIVE_ENTRY_COMMENT_UNSUPPORTED"
          : overrides.extraFieldLength === -1
            ? "IMPORT_ARCHIVE_CENTRAL_DIRECTORY_LIMIT"
            : "IMPORT_ARCHIVE_SIZE_INVALID",
      );
    expectPolicyFailure(
      entry("manifest.json", { externalFileAttributes: 0x10 }),
      "IMPORT_ARCHIVE_NON_REGULAR",
    );
  });
});

describe("frozen HekayatiArchive/v1 migration", () => {
  it("purely normalizes the one frozen shape to strict v2", () => {
    const legacy = legacyManifest();
    const untouched = structuredClone(legacy);
    const result = normalizeImportManifestBytes(
      Buffer.from(canonicalJson(legacy)),
    );
    expect(result).toMatchObject({ sourceVersion: 1, migrated: true });
    expect(result.manifest).toMatchObject({
      format: "HekayatiArchive",
      manifestVersion: 2,
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.manifest.documents[0].sha256).toBe("a".repeat(64));
    expect(result.manifest.media[0].sha256).toBe("b".repeat(64));
    expect(legacy).toEqual(untouched);
  });

  it("rejects unknown older, future, missing, and noncanonical versions", () => {
    for (const [candidate, code] of [
      [
        { format: "HekayatiArchive", schemaVersion: 0 },
        "IMPORT_ARCHIVE_OLDER_VERSION_UNSUPPORTED",
      ],
      [
        { format: "HekayatiArchive", manifestVersion: 3 },
        "IMPORT_ARCHIVE_CREATED_BY_NEWER_VERSION",
      ],
      [{ format: "HekayatiArchive" }, "IMPORT_ARCHIVE_VERSION_MISSING"],
    ] as const)
      expect(() =>
        normalizeImportManifestBytes(Buffer.from(canonicalJson(candidate))),
      ).toThrow(code);
    expect(() =>
      normalizeImportManifestBytes(
        Buffer.from(`${JSON.stringify(legacyManifest(), null, 2)}\n`),
      ),
    ).toThrow("IMPORT_ARCHIVE_MANIFEST_NOT_CANONICAL");
  });

  it("rejects malformed bytes, formats, v2 bodies, and frozen-v1 invariant drift", () => {
    expect(() => normalizeImportManifestBytes(Buffer.from([0xff]))).toThrow(
      "IMPORT_ARCHIVE_MANIFEST_UTF8_INVALID",
    );
    expect(() => normalizeImportManifestBytes(Buffer.from("{"))).toThrow(
      "IMPORT_ARCHIVE_MANIFEST_JSON_INVALID",
    );
    expect(() =>
      normalizeImportManifestBytes(
        Buffer.from(canonicalJson({ format: "Other" })),
      ),
    ).toThrow("IMPORT_ARCHIVE_FORMAT_UNSUPPORTED");
    expect(() =>
      normalizeImportManifestBytes(
        Buffer.from(
          canonicalJson({ format: "HekayatiArchive", manifestVersion: 2 }),
        ),
      ),
    ).toThrow("IMPORT_ARCHIVE_MANIFEST_INVALID");
    expect(() =>
      normalizeImportManifestBytes(
        Buffer.alloc(ARCHIVE_POLICY_V1.maxManifestBytes + 1),
      ),
    ).toThrow("IMPORT_ARCHIVE_MANIFEST_LIMIT");
    for (const mutate of [
      (value: ReturnType<typeof legacyManifest>) => {
        value.totalUncompressedBytes += 1;
      },
      (value: ReturnType<typeof legacyManifest>) => {
        delete value.checksums[value.entries[0].path];
      },
      (value: ReturnType<typeof legacyManifest>) => {
        value.entries[0].path = "data/projects/wrong.json";
      },
    ]) {
      const candidate = structuredClone(legacyManifest());
      mutate(candidate);
      expect(() =>
        normalizeImportManifestBytes(Buffer.from(canonicalJson(candidate))),
      ).toThrow("IMPORT_ARCHIVE_V1_INVALID");
    }
  });

  it("fails a direct legacy migration if canonical paths drift", () => {
    const candidate = structuredClone(legacyManifest());
    const checksum = candidate.checksums[candidate.entries[0].path];
    candidate.entries[0].path = "data/projects/wrong.json";
    candidate.checksums[candidate.entries[0].path] = checksum;
    expect(() => migrateManifestV1(candidate as never)).toThrow(
      "IMPORT_ARCHIVE_V1_MIGRATION_MISMATCH",
    );
  });
});

describe("import disk preflight", () => {
  it("uses the exact workspace formula and preserves reserve at boundary", () => {
    const input = {
      reserveBytes: 100,
      declaredUncompressedBytes: 1_000,
      newContentBytes: 200,
      canonicalDocumentBytes: 10,
    };
    const requiredBytes = 1_000 + 200 + IMPORT_WORKSPACE_FLOOR_BYTES;
    expect(
      calculateImportDiskFacts({
        ...input,
        freeBytes: requiredBytes + input.reserveBytes,
      }),
    ).toMatchObject({ requiredBytes });
    expect(() =>
      calculateImportDiskFacts({
        ...input,
        freeBytes: requiredBytes + input.reserveBytes - 1,
      }),
    ).toThrow("IMPORT_DISK_SPACE_INSUFFICIENT");
  });

  it("rejects unsafe arithmetic and uses twice canonical bytes above floor", () => {
    const canonicalDocumentBytes = IMPORT_WORKSPACE_FLOOR_BYTES;
    const requiredBytes = canonicalDocumentBytes * 2;
    expect(
      calculateImportDiskFacts({
        freeBytes: requiredBytes,
        reserveBytes: 0,
        declaredUncompressedBytes: 0,
        newContentBytes: 0,
        canonicalDocumentBytes,
      }).requiredBytes,
    ).toBe(requiredBytes);
    expect(() =>
      calculateImportDiskFacts({
        freeBytes: Number.MAX_SAFE_INTEGER,
        reserveBytes: 0,
        declaredUncompressedBytes: 0,
        newContentBytes: 0,
        canonicalDocumentBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow("IMPORT_DISK_SIZE_OVERFLOW");
  });
});

function entry(
  fileName: string,
  overrides: Partial<ArchiveCentralEntry> = {},
): ArchiveCentralEntry {
  return {
    fileName,
    fileNameRaw: Buffer.from(fileName),
    compressedSize: 1,
    uncompressedSize: 1,
    compressionMethod: 0,
    generalPurposeBitFlag: 0,
    externalFileAttributes: 0o100600 << 16,
    versionMadeBy: 3 << 8,
    extraFieldLength: 0,
    fileCommentLength: 0,
    ...overrides,
  };
}

function mediaEntry(
  index: number,
  overrides: Partial<ArchiveCentralEntry> = {},
): ArchiveCentralEntry {
  return entry(
    `media/assets/${index.toString(16).padStart(64, "0")}.pdf`,
    overrides,
  );
}

function legacyManifest() {
  const documentPath = "data/projects/01K20000000000000000000001.json";
  const mediaPath = `media/assets/${"b".repeat(64)}.png`;
  return {
    format: "HekayatiArchive",
    schemaVersion: 1,
    appVersion: "0.1.0",
    createdAt: "2026-07-16T00:00:00.000Z",
    exportId: "01K20000000000000000000002",
    mode: "project",
    scope: {
      kind: "project",
      projectId: "01K20000000000000000000001",
      customerId: "01K20000000000000000000003",
      familyId: "01K20000000000000000000004",
    },
    roots: [
      { kind: "customer", id: "01K20000000000000000000003" },
      { kind: "family", id: "01K20000000000000000000004" },
      { kind: "project", id: "01K20000000000000000000001" },
    ],
    entries: [
      {
        kind: "document",
        path: documentPath,
        collection: "projects",
        id: "01K20000000000000000000001",
        schemaVersion: 1,
        bytes: 2,
      },
      {
        kind: "media",
        path: mediaPath,
        namespace: "asset",
        assetId: "01K20000000000000000000005",
        role: "illustration",
        mime: "image/png",
        extension: "png",
        bytes: 3,
      },
    ],
    checksums: {
      [documentPath]: "a".repeat(64),
      [mediaPath]: "b".repeat(64),
    },
    totalUncompressedBytes: 5,
    snapshotHash: "c".repeat(64),
  };
}

function expectPolicyFailure(
  candidate: ArchiveCentralEntry,
  code: string,
): void {
  expect(() => new ArchivePolicyMeter().add(candidate)).toThrow(code);
}
