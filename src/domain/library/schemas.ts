import { z } from "zod";

export const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const sha256Pattern = /^[a-f0-9]{64}$/;
export const entityIdSchema = z.string().regex(ulidPattern);
const timestampSchema = z.iso.datetime();
const shortText = z.string().max(240);
const longText = z.string().max(8_000);
const nullableShortText = shortText.nullable();
const nullableLongText = longText.nullable();
const textList = z.array(shortText).max(100);
const textMap = z.record(z.string().min(1).max(80), z.string().max(1_000));

const baseDocumentFields = {
  id: entityIdSchema,
  schemaVersion: z.literal(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const lifecycleStatusSchema = z.enum(["active", "archived"]);
export const consentRecordSchema = z
  .object({
    granted: z.boolean(),
    date: timestampSchema,
    note: longText,
  })
  .strict();

export const customerSchema = z
  .object({
    ...baseDocumentFields,
    name: z.string().trim().min(1).max(240),
    whatsapp: z.string().max(100),
    notes: longText,
    consent: consentRecordSchema.nullable(),
    status: lifecycleStatusSchema,
  })
  .strict();

export const familySchema = z
  .object({
    ...baseDocumentFields,
    customerId: entityIdSchema,
    name: z.string().trim().min(1).max(240),
    anchorCharacterId: entityIdSchema.nullable(),
    status: lifecycleStatusSchema,
  })
  .strict();

export const relationshipTypeSchema = z.enum([
  "main_child",
  "father",
  "mother",
  "brother",
  "sister",
  "grandfather",
  "grandmother",
  "friend",
  "teacher",
  "pet",
  "custom",
]);

export const relationshipSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("custom"),
      customLabel: z.string().trim().min(1).max(120),
    })
    .strict(),
  ...relationshipTypeSchema.options
    .filter((option) => option !== "custom")
    .map((option) => z.object({ type: z.literal(option) }).strict()),
]);

export const characterSourceModeSchema = z.enum([
  "photo",
  "description",
  "both",
]);

const characterProfileBaseSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    nickname: nullableShortText,
    relationship: relationshipSchema,
    appearanceDescription: z.string().max(8_000),
    ageOrRange: nullableShortText,
    gender: nullableShortText,
    skinTone: nullableShortText,
    hair: nullableLongText,
    eyeColor: nullableShortText,
    relativeHeight: nullableShortText,
    build: nullableShortText,
    distinguishingFeatures: textList,
    glasses: nullableLongText,
    hijab: nullableLongText,
    accessories: textList,
    interests: textList,
    favoriteObjects: textList,
    favoriteColor: nullableShortText,
    personalityTraits: textList,
    speakingStyle: nullableLongText,
    notes: nullableLongText,
    sourceMode: characterSourceModeSchema,
    referencePhotoIds: z.array(entityIdSchema).max(100),
    traits: textMap,
  })
  .strict();

export const characterProfileSchema = characterProfileBaseSchema.superRefine(
  (profile, context) => {
    requireUniqueIds(profile.referencePhotoIds, context);
    if (
      (profile.sourceMode === "description" || profile.sourceMode === "both") &&
      profile.appearanceDescription.trim().length === 0
    ) {
      issue(
        context,
        ["appearanceDescription"],
        "DESCRIPTION_SOURCE_REQUIRES_TEXT",
      );
    }
    if (
      (profile.sourceMode === "photo" || profile.sourceMode === "both") &&
      profile.referencePhotoIds.length === 0
    ) {
      issue(context, ["referencePhotoIds"], "PHOTO_SOURCE_REQUIRES_REFERENCE");
    }
    if (
      profile.sourceMode === "description" &&
      profile.referencePhotoIds.length > 0
    ) {
      issue(
        context,
        ["referencePhotoIds"],
        "DESCRIPTION_SOURCE_FORBIDS_REFERENCE",
      );
    }
  },
);

export const characterSchema = z
  .object({
    ...baseDocumentFields,
    familyId: entityIdSchema,
    status: lifecycleStatusSchema,
    currentVersionId: entityIdSchema,
  })
  .strict();

export const characterVersionSchema = z
  .object({
    ...baseDocumentFields,
    characterId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    profile: characterProfileSchema,
  })
  .strict();

export const lookContentSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    clothing: longText,
    appearanceOverrides: textMap,
    referencePhotoIds: z.array(entityIdSchema).max(100),
  })
  .strict()
  .superRefine((content, context) => {
    requireUniqueIds(content.referencePhotoIds, context);
  });

export const lookSchema = z
  .object({
    ...baseDocumentFields,
    characterId: entityIdSchema,
    status: lifecycleStatusSchema,
    currentVersionId: entityIdSchema,
  })
  .strict();

export const lookVersionSchema = z
  .object({
    ...baseDocumentFields,
    lookId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    content: lookContentSchema,
  })
  .strict();

export const changeEventSchema = z
  .object({
    ...baseDocumentFields,
    entity: z.enum([
      "character",
      "look",
      "project_override",
      "library_visibility",
    ]),
    entityId: entityIdSchema,
    fromVersionId: entityIdSchema.nullable(),
    toVersionId: entityIdSchema.nullable(),
    changeType: z.enum([
      "permanent_appearance",
      "non_visual_profile",
      "shared_look",
      "project_look_override",
      "rename",
      "archive_restore",
    ]),
    matrixRow: z.enum(["IM-01", "IM-02", "IM-03", "IM-04", "IM-05", "IM-21"]),
    changedFields: z.array(z.string().min(1).max(80)).max(100),
    correlationId: entityIdSchema,
    occurredAt: timestampSchema,
  })
  .strict();

export const invalidationReceiptSchema = z
  .object({
    ...baseDocumentFields,
    eventId: entityIdSchema,
    consumedAt: timestampSchema,
    consequenceHash: z.string().regex(sha256Pattern),
    affectedIds: z.array(entityIdSchema).max(10_000),
  })
  .strict();

export const photoWarningCodeSchema = z.enum([
  "PHOTO_LIMITED_REFERENCES",
  "PHOTO_BLURRY",
  "PHOTO_FACE_TOO_SMALL",
  "PHOTO_MULTIPLE_PEOPLE",
  "PHOTO_EXTREME_SHADOWS",
  "PHOTO_OBSTRUCTED",
  "PHOTO_FILTER_SUSPECTED",
  "PHOTO_AGE_CONFLICT",
  "PHOTO_HAIR_CONFLICT",
  "PHOTO_CLOTHING_CONFLICT",
]);

const qualityWarningSchema = z
  .object({
    code: photoWarningCodeSchema,
    source: z.enum(["local_check", "operator"]),
    metric: shortText.optional(),
    threshold: z.number().finite().optional(),
    details: longText.optional(),
  })
  .strict()
  .superRefine((warning, context) => {
    if (
      warning.source === "local_check" &&
      (warning.metric === undefined || warning.threshold === undefined)
    ) {
      issue(context, [], "LOCAL_WARNING_REQUIRES_EVIDENCE");
    }
    if (warning.source === "operator" && !warning.details?.trim()) {
      issue(context, [], "OPERATOR_WARNING_REQUIRES_OBSERVATION");
    }
  });

export const subjectSelectionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .superRefine((box, context) => {
    if (box.x + box.width > 1 || box.y + box.height > 1)
      issue(context, [], "SUBJECT_SELECTION_OUT_OF_BOUNDS");
  });

const qualitySchema = z
  .object({
    policyVersion: z.string().min(1).max(80),
    metrics: z
      .object({
        widthPx: z.number().int().positive(),
        heightPx: z.number().int().positive(),
        blurScore: z.number().finite(),
        exposureScore: z.number().finite(),
        shadowFraction: z.number().min(0).max(1),
        subjectBoxAreaRatio: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    warnings: z.array(qualityWarningSchema).max(100),
    observations: z
      .object({
        peopleCount: z.number().int().nonnegative().optional(),
        obstruction: shortText.optional(),
        filterSuspected: z.boolean().optional(),
        apparentAgeBand: shortText.optional(),
        hair: shortText.optional(),
        clothing: shortText.optional(),
      })
      .strict(),
  })
  .strict();

const photoOwnerSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("character"), characterId: entityIdSchema })
    .strict(),
  z
    .object({
      type: z.literal("look"),
      characterId: entityIdSchema,
      lookId: entityIdSchema,
    })
    .strict(),
]);

const referencePhotoBaseSchema = z
  .object({
    ...baseDocumentFields,
    customerId: entityIdSchema,
    familyId: entityIdSchema,
    owner: photoOwnerSchema,
    kind: z.enum(["face", "full_body", "clothing", "other"]),
    originalAssetId: entityIdSchema,
    workingAssetId: entityIdSchema,
    thumbnailAssetId: entityIdSchema,
    providerAssetId: entityIdSchema.nullable(),
    subjectSelection: subjectSelectionSchema.nullable(),
    quality: qualitySchema,
    usableAsFaceReference: z.boolean(),
    supersedesPhotoId: entityIdSchema.nullable(),
  })
  .strict();

type ReferencePhotoCandidate = z.infer<typeof referencePhotoBaseSchema>;

export const referencePhotoSchema = referencePhotoBaseSchema.superRefine(
  validateReferencePhoto,
);

function validateReferencePhoto(
  photo: ReferencePhotoCandidate,
  context: z.RefinementCtx,
): void {
  validateReferenceAssetSeparation(photo, context);
  validateReferenceSubject(photo, context);
  validateReferenceProviderAsset(photo, context);
  if (photo.usableAsFaceReference !== (photo.kind === "face"))
    issue(context, ["usableAsFaceReference"], "FACE_REFERENCE_KIND_MISMATCH");
}

function validateReferenceAssetSeparation(
  photo: ReferencePhotoCandidate,
  context: z.RefinementCtx,
): void {
  if (
    photo.workingAssetId === photo.originalAssetId ||
    photo.thumbnailAssetId === photo.originalAssetId ||
    photo.providerAssetId === photo.originalAssetId
  )
    issue(context, [], "ORIGINAL_CANNOT_BE_DERIVATIVE_ASSET");
  if (photo.thumbnailAssetId === photo.workingAssetId)
    issue(context, ["thumbnailAssetId"], "THUMBNAIL_MUST_BE_DERIVED");
}

function validateReferenceSubject(
  photo: ReferencePhotoCandidate,
  context: z.RefinementCtx,
): void {
  if (photo.kind === "face" && !photo.subjectSelection)
    issue(context, ["subjectSelection"], "PHOTO_SUBJECT_SELECTION_REQUIRED");
  if (
    (photo.kind === "face" &&
      photo.quality.observations.peopleCount === undefined) ||
    ((photo.quality.observations.peopleCount ?? 0) > 1 &&
      !photo.subjectSelection)
  )
    issue(
      context,
      ["quality", "observations", "peopleCount"],
      "PHOTO_SUBJECT_SELECTION_REQUIRED",
    );
  if (photo.subjectSelection) {
    if (
      photo.quality.metrics.subjectBoxAreaRatio === null ||
      Math.abs(
        photo.quality.metrics.subjectBoxAreaRatio -
          photo.subjectSelection.width * photo.subjectSelection.height,
      ) > 0.000001
    )
      issue(
        context,
        ["quality", "metrics", "subjectBoxAreaRatio"],
        "SUBJECT_AREA_METRIC_MISMATCH",
      );
  }
}

function validateReferenceProviderAsset(
  photo: ReferencePhotoCandidate,
  context: z.RefinementCtx,
): void {
  if (photo.subjectSelection) {
    if (
      !photo.providerAssetId ||
      photo.providerAssetId === photo.workingAssetId ||
      photo.providerAssetId === photo.thumbnailAssetId
    )
      issue(
        context,
        ["providerAssetId"],
        "SUBJECT_PROVIDER_ASSET_MUST_BE_CROP",
      );
  } else if (
    photo.kind !== "face" &&
    photo.providerAssetId !== null &&
    photo.providerAssetId !== photo.workingAssetId
  ) {
    issue(
      context,
      ["providerAssetId"],
      "NON_FACE_PROVIDER_ASSET_MUST_BE_WORKING",
    );
  }
}

export const originalAssetRecordSchema = z
  .object({
    ...baseDocumentFields,
    sha256: z.string().regex(sha256Pattern),
    sourceMime: z.enum(["image/heic", "image/heif", "image/jpeg", "image/png"]),
    extension: z.enum(["heic", "heif", "jpg", "jpeg", "png"]),
    bytes: z.number().int().positive(),
    refCount: z.number().int().positive(),
  })
  .strict()
  .superRefine((record, context) => {
    const allowed =
      record.sourceMime === "image/jpeg"
        ? ["jpg", "jpeg"]
        : record.sourceMime === "image/png"
          ? ["png"]
          : record.sourceMime === "image/heic"
            ? ["heic"]
            : ["heif"];
    if (!allowed.includes(record.extension))
      issue(context, ["extension"], "ORIGINAL_MIME_EXTENSION_MISMATCH");
  });

export const characterEditIntentSchema = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.literal("project_only"),
      projectId: entityIdSchema,
      characterId: entityIdSchema,
    })
    .strict(),
  z
    .object({
      intent: z.literal("update_base"),
      characterId: entityIdSchema,
      expectedVersionId: entityIdSchema,
      profile: characterProfileSchema,
    })
    .strict(),
  z
    .object({
      intent: z.literal("save_as_new_look"),
      characterId: entityIdSchema,
      content: lookContentSchema,
    })
    .strict(),
]);

export type Customer = z.infer<typeof customerSchema>;
export type ConsentRecord = z.infer<typeof consentRecordSchema>;
export type Family = z.infer<typeof familySchema>;
export type Relationship = z.infer<typeof relationshipSchema>;
export type CharacterProfile = z.infer<typeof characterProfileSchema>;
export type Character = z.infer<typeof characterSchema>;
export type CharacterVersion = z.infer<typeof characterVersionSchema>;
export type LookContent = z.infer<typeof lookContentSchema>;
export type Look = z.infer<typeof lookSchema>;
export type LookVersion = z.infer<typeof lookVersionSchema>;
export type ChangeEvent = z.infer<typeof changeEventSchema>;
export type InvalidationReceipt = z.infer<typeof invalidationReceiptSchema>;
export type ReferencePhoto = z.infer<typeof referencePhotoSchema>;
export type OriginalAssetRecord = z.infer<typeof originalAssetRecordSchema>;
export type CharacterEditIntent = z.infer<typeof characterEditIntentSchema>;

function requireUniqueIds(
  ids: readonly string[],
  context: z.RefinementCtx,
): void {
  if (new Set(ids).size !== ids.length)
    issue(context, ["referencePhotoIds"], "DUPLICATE_REFERENCE_PHOTO_ID");
}

function issue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}
