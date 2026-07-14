import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assetRecordSchema,
  type AssetRecord,
} from "../../src/assets/asset-store.js";
import { JobError } from "../../src/jobs/errors.js";
import {
  LibraryImageReferenceResolver,
  type ApprovedSheetMetadata,
  type ApprovedSheetLineageReader,
} from "../../src/jobs/image-references.js";
import { imageRequestDraftSchema } from "../../src/providers/contract.js";

const bytes = new Uint8Array([137, 80, 78, 71]);

describe("image reference resolution", () => {
  it("inspects current direct-photo metadata before loading only the clean asset", async () => {
    const trace: string[] = [];
    const draft = photoDraft();
    const asset = referenceAsset();
    const resolver = new LibraryImageReferenceResolver(
      {
        resolveProviderPhotoReferenceMetadata: () => {
          trace.push("photo-metadata");
          return { providerAssetId: asset.id };
        },
        assertPhotoConsent: () => {
          throw new Error("UNREACHABLE");
        },
      },
      {
        get: () => {
          trace.push("asset-metadata");
          return asset;
        },
        read: async () => {
          trace.push("asset-read");
          return bytes;
        },
      },
    );
    const inspected = await resolver.inspect(draft);
    expect(trace).toEqual(["photo-metadata", "asset-metadata"]);
    const resolved = await resolver.load(draft, inspected);
    expect(trace).toEqual(["photo-metadata", "asset-metadata", "asset-read"]);
    expect(resolved.referenceImages[0]).toMatchObject({
      source: "reference_photo",
      provenanceAssetId: asset.id,
      bytes,
    });
    expect(resolved.referenceImages[0]).not.toHaveProperty("selectedAssetId");
  });

  it("requires current consent only for trusted photo-derived sheets", async () => {
    const consentUses: string[] = [];
    const sheetReader = sheetLineage("photo_derived");
    const resolver = new LibraryImageReferenceResolver(
      {
        resolveProviderPhotoReferenceMetadata: () => {
          throw new Error("UNREACHABLE");
        },
        assertPhotoConsent: (_customerId, use) => consentUses.push(use),
      },
      assetPort(sheetAsset()),
      sheetReader,
    );
    await resolver.inspect(sheetDraft());
    expect(consentUses).toEqual(["photo_derived_sheet"]);

    const descriptionOnly = new LibraryImageReferenceResolver(
      {
        resolveProviderPhotoReferenceMetadata: () => {
          throw new Error("UNREACHABLE");
        },
        assertPhotoConsent: () => consentUses.push("unexpected"),
      },
      assetPort(sheetAsset()),
      sheetLineage("description_only"),
    );
    await descriptionOnly.inspect(sheetDraft());
    expect(consentUses).toEqual(["photo_derived_sheet"]);
  });

  it.each(["PHOTO_CONSENT_NOT_RECORDED", "PHOTO_CONSENT_NOT_GRANTED"])(
    "loads no metadata or bytes when direct-photo consent fails with %s",
    async (code) => {
      let assetMetadataReads = 0;
      let byteReads = 0;
      const resolver = new LibraryImageReferenceResolver(
        {
          resolveProviderPhotoReferenceMetadata: () => {
            throw new JobError(code);
          },
          assertPhotoConsent: () => undefined,
        },
        {
          get: () => {
            assetMetadataReads += 1;
            return referenceAsset();
          },
          read: async () => {
            byteReads += 1;
            return bytes;
          },
        },
      );
      await expect(resolver.inspect(photoDraft())).rejects.toMatchObject({
        code,
      });
      expect({ assetMetadataReads, byteReads }).toEqual({
        assetMetadataReads: 0,
        byteReads: 0,
      });
    },
  );

  it("rejects a changed direct-photo asset pin before reading bytes", async () => {
    let metadataReads = 0;
    let byteReads = 0;
    const resolver = new LibraryImageReferenceResolver(
      {
        resolveProviderPhotoReferenceMetadata: () => ({
          providerAssetId: "01J00000000000000000000099",
        }),
        assertPhotoConsent: () => undefined,
      },
      {
        get: () => {
          metadataReads += 1;
          return referenceAsset();
        },
        read: async () => {
          byteReads += 1;
          return bytes;
        },
      },
    );
    await expect(resolver.inspect(photoDraft())).rejects.toMatchObject({
      code: "JOB_REFERENCE_ASSET_MISMATCH",
    });
    expect({ metadataReads, byteReads }).toEqual({
      metadataReads: 0,
      byteReads: 0,
    });
  });

  it.each([
    "SHEET_NOT_FOUND",
    "SHEET_NOT_APPROVED",
    "SHEET_REFERENCE_MISMATCH",
    "SHEET_LINEAGE_INVALID",
  ] as const)(
    "fails closed for sheet lineage result %s before asset access",
    async (code) => {
      let metadataReads = 0;
      let byteReads = 0;
      const resolver = new LibraryImageReferenceResolver(
        unusedPhotoLibrary(),
        {
          get: () => {
            metadataReads += 1;
            return sheetAsset();
          },
          read: async () => {
            byteReads += 1;
            return bytes;
          },
        },
        {
          resolveApprovedSheetReferenceMetadata: async () => ({
            ok: false,
            code,
          }),
        },
      );
      await expect(resolver.inspect(sheetDraft())).rejects.toMatchObject({
        code,
      });
      expect({ metadataReads, byteReads }).toEqual({
        metadataReads: 0,
        byteReads: 0,
      });
    },
  );

  it.each([
    ["customerId", "customer-other"],
    ["familyId", "family-other"],
    ["characterId", "character-other"],
    ["characterVersionId", "character-version-other"],
    ["sheetAssetId", "01J00000000000000000000099"],
  ] as const)(
    "rejects changed sheet %s lineage before reading bytes",
    async (field, value) => {
      let reads = 0;
      const metadata = { ...sheetMetadata(), [field]: value };
      const resolver = new LibraryImageReferenceResolver(
        unusedPhotoLibrary(),
        {
          get: () => sheetAsset(),
          read: async () => {
            reads += 1;
            return bytes;
          },
        },
        successfulSheetReader(metadata),
      );
      await expect(resolver.inspect(sheetDraft())).rejects.toMatchObject({
        code: "SHEET_REFERENCE_MISMATCH",
      });
      expect(reads).toBe(0);
    },
  );

  it("rejects changed sheet appearance lineage before reading bytes", async () => {
    let reads = 0;
    const metadata = {
      ...sheetMetadata(),
      appearance: {
        type: "shared_look" as const,
        lookId: "look-other",
        lookVersionId: "look-version-other",
      },
    };
    const resolver = new LibraryImageReferenceResolver(
      unusedPhotoLibrary(),
      {
        get: () => sheetAsset(),
        read: async () => {
          reads += 1;
          return bytes;
        },
      },
      successfulSheetReader(metadata),
    );
    await expect(resolver.inspect(sheetDraft())).rejects.toMatchObject({
      code: "SHEET_REFERENCE_MISMATCH",
    });
    expect(reads).toBe(0);
  });

  it("checks photo-derived sheet consent before asset metadata or bytes", async () => {
    let metadataReads = 0;
    let byteReads = 0;
    const resolver = new LibraryImageReferenceResolver(
      {
        ...unusedPhotoLibrary(),
        assertPhotoConsent: () => {
          throw new JobError("PHOTO_CONSENT_NOT_GRANTED");
        },
      },
      {
        get: () => {
          metadataReads += 1;
          return sheetAsset();
        },
        read: async () => {
          byteReads += 1;
          return bytes;
        },
      },
      sheetLineage("photo_derived"),
    );
    await expect(resolver.inspect(sheetDraft())).rejects.toMatchObject({
      code: "PHOTO_CONSENT_NOT_GRANTED",
    });
    expect({ metadataReads, byteReads }).toEqual({
      metadataReads: 0,
      byteReads: 0,
    });
  });

  it("fails closed without an approved-sheet lineage reader", async () => {
    const resolver = new LibraryImageReferenceResolver(
      {
        resolveProviderPhotoReferenceMetadata: () => {
          throw new Error("UNREACHABLE");
        },
        assertPhotoConsent: () => undefined,
      },
      assetPort(sheetAsset()),
    );
    await expect(resolver.inspect(sheetDraft())).rejects.toMatchObject({
      code: "JOB_SHEET_LINEAGE_READER_MISSING",
    });
  });

  it("rejects originals, wrong roles, MIME types, and changed bytes", async () => {
    const draft = photoDraft();
    for (const invalid of [
      referenceAsset({ origin: "upload" }),
      referenceAsset({ role: "thumbnail" }),
      referenceAsset({ exifStripped: false }),
    ]) {
      const resolver = photoResolver(invalid, bytes);
      await expect(resolver.inspect(draft)).rejects.toBeInstanceOf(JobError);
    }
    const wrongMime = referenceAsset({ mime: "application/pdf" });
    await expect(
      photoResolver(wrongMime, bytes).inspect(draft),
    ).rejects.toMatchObject({
      code: "JOB_REFERENCE_MIME_INELIGIBLE",
    });
    const resolver = photoResolver(referenceAsset(), new Uint8Array([0]));
    const inspected = await resolver.inspect(draft);
    await expect(resolver.load(draft, inspected)).rejects.toMatchObject({
      code: "JOB_REFERENCE_CHECKSUM_MISMATCH",
    });
    await expect(resolver.load(draft, [])).rejects.toMatchObject({
      code: "JOB_REFERENCE_SNAPSHOT_MISMATCH",
    });
  });
});

function unusedPhotoLibrary() {
  return {
    resolveProviderPhotoReferenceMetadata: () => {
      throw new Error("UNREACHABLE");
    },
    assertPhotoConsent: () => undefined,
  };
}

function photoResolver(asset: AssetRecord, loaded: Uint8Array) {
  return new LibraryImageReferenceResolver(
    {
      resolveProviderPhotoReferenceMetadata: () => ({
        providerAssetId: asset.id,
      }),
      assertPhotoConsent: () => undefined,
    },
    { get: () => asset, read: async () => loaded },
  );
}

function assetPort(asset: AssetRecord) {
  return { get: () => asset, read: async () => bytes };
}

function referenceAsset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  const base = assetRecordSchema.parse({
    id: "01J00000000000000000000010",
    schemaVersion: 1,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    extension: "png",
    bytes: bytes.length,
    refCount: 1,
    mime: "image/png",
    role: "reference_photo",
    origin: "derived",
    exifStripped: true,
  });
  return { ...base, ...overrides };
}

function sheetAsset(): AssetRecord {
  return referenceAsset({
    id: "01J00000000000000000000011",
    role: "sheet_view",
    origin: "generated",
    provenance: {
      provider: "mock",
      model: "mock-image-v1",
      at: "2026-07-14T00:00:00.000Z",
      jobId: "01J00000000000000000000012",
      inputVersionRefs: {},
      promptVersion: "fixture-v1",
      referencedAssetIds: [],
      attempt: 1,
      settingsSnapshot: {
        schemaVersion: 1,
        settingsHash: "a".repeat(64),
      },
    },
    exifStripped: undefined,
  });
}

function photoDraft() {
  return imageRequestDraftSchema.parse({
    ...baseDraft(),
    referenceImages: [
      {
        source: "reference_photo",
        referencePhotoId: "photo-1",
        customerId: "customer-1",
        familyId: "family-1",
        characterId: "character-1",
        owner: {
          type: "character",
          characterVersionId: "character-version-1",
        },
        providerAssetId: "01J00000000000000000000010",
      },
    ],
  });
}

function sheetDraft() {
  return imageRequestDraftSchema.parse({
    ...baseDraft(),
    referenceImages: [
      {
        source: "approved_character_sheet",
        characterSheetId: "sheet-1",
        customerId: "customer-1",
        familyId: "family-1",
        characterId: "character-1",
        characterVersionId: "character-version-1",
        appearance: {
          type: "shared_look",
          lookId: "look-1",
          lookVersionId: "look-version-1",
        },
        sheetAssetId: "01J00000000000000000000011",
      },
    ],
  });
}

function baseDraft() {
  return {
    styleId: "modern_cartoon" as const,
    scene: {
      pageNumber: 1,
      description: "مشهد اصطناعي",
      participants: [],
      environment: "حديقة",
      composition: "متوازنة",
      cameraFraming: "متوسط",
    },
    negativeConstraints: ["no_extra_people"],
    output: { minWidthPx: 1024, minHeightPx: 1024 },
  };
}

function sheetLineage(
  lineageSource: "description_only" | "photo_derived",
): ApprovedSheetLineageReader {
  return successfulSheetReader({ ...sheetMetadata(), lineageSource });
}

function successfulSheetReader(
  value: ApprovedSheetMetadata,
): ApprovedSheetLineageReader {
  return {
    resolveApprovedSheetReferenceMetadata: async () => ({
      ok: true,
      value,
    }),
  };
}

function sheetMetadata(): ApprovedSheetMetadata {
  return {
    characterSheetId: "sheet-1",
    customerId: "customer-1",
    familyId: "family-1",
    characterId: "character-1",
    characterVersionId: "character-version-1",
    appearance: {
      type: "shared_look",
      lookId: "look-1",
      lookVersionId: "look-version-1",
    },
    sheetAssetId: "01J00000000000000000000011",
    lineageSource: "description_only",
  };
}
