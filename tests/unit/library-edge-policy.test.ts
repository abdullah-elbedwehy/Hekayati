import { describe, expect, it } from "vitest";
import { ulid } from "ulid";

import {
  LibraryError,
  characterEditIntentSchema,
  characterProfileSchema,
  classifyCharacterChange,
  classifyLookChange,
  libraryErrorCode,
  originalAssetRecordSchema,
  referencePhotoSchema,
  relationshipKey,
  subjectSelectionSchema,
} from "../../src/domain/library/index.js";

describe("strict library schemas", () => {
  it("rejects missing descriptions and repeated reference IDs", () => {
    expect(() =>
      characterProfileSchema.parse(
        profile({ sourceMode: "description", appearanceDescription: "" }),
      ),
    ).toThrow("DESCRIPTION_SOURCE_REQUIRES_TEXT");
    expect(() =>
      characterProfileSchema.parse(
        profile({
          sourceMode: "both",
          appearanceDescription: "",
          referencePhotoIds: [ulid()],
        }),
      ),
    ).toThrow("DESCRIPTION_SOURCE_REQUIRES_TEXT");
    const photoId = ulid();
    expect(() =>
      characterProfileSchema.parse(
        profile({ sourceMode: "photo", referencePhotoIds: [photoId, photoId] }),
      ),
    ).toThrow("DUPLICATE_REFERENCE_PHOTO_ID");
  });

  it("requires explicit evidence for local and operator warnings", () => {
    expect(() =>
      referencePhotoSchema.parse(
        photo({
          quality: quality({
            warnings: [{ code: "PHOTO_BLURRY", source: "local_check" }],
          }),
        }),
      ),
    ).toThrow("LOCAL_WARNING_REQUIRES_EVIDENCE");
    expect(() =>
      referencePhotoSchema.parse(
        photo({
          quality: quality({
            warnings: [
              { code: "PHOTO_OBSTRUCTED", source: "operator", details: "" },
            ],
          }),
        }),
      ),
    ).toThrow("OPERATOR_WARNING_REQUIRES_OBSERVATION");
    expect(
      referencePhotoSchema.parse(
        photo({
          quality: quality({
            warnings: [
              {
                code: "PHOTO_BLURRY",
                source: "local_check",
                metric: "blurScore",
                threshold: 80,
              },
              {
                code: "PHOTO_OBSTRUCTED",
                source: "operator",
                details: "obstruction:recorded",
              },
            ],
          }),
        }),
      ).quality.warnings,
    ).toHaveLength(2);
  });

  it("bounds subject rectangles on both axes", () => {
    expect(() =>
      subjectSelectionSchema.parse({ x: 0.8, y: 0, width: 0.3, height: 0.2 }),
    ).toThrow("SUBJECT_SELECTION_OUT_OF_BOUNDS");
    expect(() =>
      subjectSelectionSchema.parse({ x: 0, y: 0.9, width: 0.2, height: 0.2 }),
    ).toThrow("SUBJECT_SELECTION_OUT_OF_BOUNDS");
  });

  it("keeps originals, thumbnails, full frames, and face crops distinct", () => {
    const base = facePhoto();
    for (const candidate of [
      { workingAssetId: base.originalAssetId },
      { thumbnailAssetId: base.originalAssetId },
      { providerAssetId: base.originalAssetId },
    ])
      expect(() =>
        referencePhotoSchema.parse({ ...base, ...candidate }),
      ).toThrow("ORIGINAL_CANNOT_BE_DERIVATIVE_ASSET");
    expect(() =>
      referencePhotoSchema.parse({
        ...base,
        thumbnailAssetId: base.workingAssetId,
      }),
    ).toThrow("THUMBNAIL_MUST_BE_DERIVED");
    expect(() =>
      referencePhotoSchema.parse({ ...base, providerAssetId: null }),
    ).toThrow("SUBJECT_PROVIDER_ASSET_MUST_BE_CROP");
    expect(() =>
      referencePhotoSchema.parse({
        ...base,
        providerAssetId: base.thumbnailAssetId,
      }),
    ).toThrow("SUBJECT_PROVIDER_ASSET_MUST_BE_CROP");
  });

  it("requires explainable face area and canonical non-face provider assets", () => {
    expect(() =>
      referencePhotoSchema.parse({
        ...facePhoto(),
        quality: quality({ subjectBoxAreaRatio: null }),
      }),
    ).toThrow("SUBJECT_AREA_METRIC_MISMATCH");
    expect(() =>
      referencePhotoSchema.parse({
        ...facePhoto(),
        quality: quality({ subjectBoxAreaRatio: 0.3 }),
      }),
    ).toThrow("SUBJECT_AREA_METRIC_MISMATCH");
    expect(() =>
      referencePhotoSchema.parse(photo({ providerAssetId: ulid() })),
    ).toThrow("NON_FACE_PROVIDER_ASSET_MUST_BE_WORKING");
    expect(() =>
      referencePhotoSchema.parse(
        photo({ quality: quality({ observations: { peopleCount: 2 } }) }),
      ),
    ).toThrow("PHOTO_SUBJECT_SELECTION_REQUIRED");
    const selected = photo({
      providerAssetId: ulid(),
      subjectSelection: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      quality: quality({ subjectBoxAreaRatio: 0.25 }),
    });
    expect(referencePhotoSchema.parse(selected).providerAssetId).toBe(
      selected.providerAssetId,
    );
    expect(
      referencePhotoSchema.parse(photo({ providerAssetId: null })).kind,
    ).toBe("other");
  });

  it("validates every original MIME/extension branch", () => {
    for (const [sourceMime, extension] of [
      ["image/jpeg", "jpeg"],
      ["image/png", "png"],
      ["image/heic", "heic"],
      ["image/heif", "heif"],
    ] as const)
      expect(
        originalAssetRecordSchema.parse(original({ sourceMime, extension }))
          .extension,
      ).toBe(extension);
    expect(() =>
      originalAssetRecordSchema.parse(
        original({ sourceMime: "image/png", extension: "jpg" }),
      ),
    ).toThrow("ORIGINAL_MIME_EXTENSION_MISMATCH");
  });
});

describe("closed library policy unions", () => {
  it("parses exactly the three character edit destinations", () => {
    const characterId = ulid();
    expect(
      characterEditIntentSchema.parse({
        intent: "project_only",
        projectId: ulid(),
        characterId,
      }).intent,
    ).toBe("project_only");
    expect(
      characterEditIntentSchema.parse({
        intent: "update_base",
        characterId,
        expectedVersionId: ulid(),
        profile: characterProfileSchema.parse(profile()),
      }).intent,
    ).toBe("update_base");
    expect(
      characterEditIntentSchema.parse({
        intent: "save_as_new_look",
        characterId,
        content: {
          name: "يومي",
          clothing: "قميص",
          appearanceOverrides: {},
          referencePhotoIds: [],
        },
      }).intent,
    ).toBe("save_as_new_look");
  });

  it("covers empty and changed classification paths", () => {
    const current = characterProfileSchema.parse(profile());
    expect(classifyCharacterChange(current, current)).toEqual([]);
    const look = {
      name: "يومي",
      clothing: "قميص",
      appearanceOverrides: {},
      referencePhotoIds: [],
    };
    expect(classifyLookChange(look, look)).toEqual([]);
    expect(
      classifyLookChange(look, { ...look, name: "رسمي" })[0]?.matrixRow,
    ).toBe("IM-03");
  });

  it("normalizes custom relationship labels and extracts only safe errors", () => {
    expect(relationshipKey({ type: "custom", customLabel: "  Coach  " })).toBe(
      "custom:coach",
    );
    expect(libraryErrorCode(new LibraryError("LOOK_NOT_FOUND"))).toBe(
      "LOOK_NOT_FOUND",
    );
    expect(libraryErrorCode(new Error("LOOK_NOT_FOUND"))).toBeNull();
  });
});

function profile(overrides: Record<string, unknown> = {}) {
  return {
    name: "ليلى",
    nickname: null,
    relationship: { type: "sister" },
    appearanceDescription: "طفلة بشعر أسود",
    ageOrRange: "7",
    gender: "أنثى",
    skinTone: "قمحي",
    hair: "أسود",
    eyeColor: "بني",
    relativeHeight: "متوسط",
    build: "متوسط",
    distinguishingFeatures: [],
    glasses: null,
    hijab: null,
    accessories: [],
    interests: [],
    favoriteObjects: [],
    favoriteColor: null,
    personalityTraits: [],
    speakingStyle: null,
    notes: null,
    sourceMode: "description",
    referencePhotoIds: [],
    traits: {},
    ...overrides,
  };
}

function photo(overrides: Record<string, unknown> = {}) {
  const workingAssetId = ulid();
  return {
    id: ulid(),
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    customerId: ulid(),
    familyId: ulid(),
    owner: { type: "character", characterId: ulid() },
    kind: "other",
    originalAssetId: ulid(),
    workingAssetId,
    thumbnailAssetId: ulid(),
    providerAssetId: workingAssetId,
    subjectSelection: null,
    quality: quality(),
    usableAsFaceReference: false,
    supersedesPhotoId: null,
    ...overrides,
  };
}

function facePhoto() {
  return photo({
    kind: "face",
    providerAssetId: ulid(),
    subjectSelection: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    quality: quality({
      subjectBoxAreaRatio: 0.25,
      observations: { peopleCount: 1 },
    }),
    usableAsFaceReference: true,
  });
}

function quality(
  overrides: {
    warnings?: unknown[];
    subjectBoxAreaRatio?: number | null;
    observations?: Record<string, unknown>;
  } = {},
) {
  return {
    policyVersion: "PhotoQualityPolicy/v1",
    metrics: {
      widthPx: 1000,
      heightPx: 1000,
      blurScore: 100,
      exposureScore: 0.5,
      shadowFraction: 0.1,
      subjectBoxAreaRatio: overrides.subjectBoxAreaRatio ?? null,
    },
    warnings: overrides.warnings ?? [],
    observations: overrides.observations ?? {},
  };
}

function original(overrides: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    sha256: "a".repeat(64),
    bytes: 12,
    refCount: 1,
    ...overrides,
  };
}
