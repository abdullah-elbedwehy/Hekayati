import { z } from "zod";

import { hashCanonical } from "../layout/hashes.js";
import { persistedPdfFactsSchema } from "./preflight-schema.js";

const entityIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const timestampSchema = z.iso.datetime();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const codeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/);
const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const finiteNumber = z.number().finite();

const baseDocument = {
  id: entityIdSchema,
  schemaVersion: z.literal(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

const revisionedDocument = {
  ...baseDocument,
  revision: z.number().int().nonnegative(),
};

export const printNormalizedRegionSchema = z
  .object({
    x: finiteNumber.min(0).max(1),
    y: finiteNumber.min(0).max(1),
    width: finiteNumber.positive().max(1),
    height: finiteNumber.positive().max(1),
  })
  .strict()
  .superRefine((region, context) => {
    if (region.x + region.width > 1 + 1e-9)
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: "REGION_WIDTH_OUT_OF_BOUNDS",
      });
    if (region.y + region.height > 1 + 1e-9)
      context.addIssue({
        code: "custom",
        path: ["height"],
        message: "REGION_HEIGHT_OUT_OF_BOUNDS",
      });
  });

export const printerBlankRuleSchema = z
  .object({
    position: z.enum(["before_interior", "after_interior"]),
    count: z.number().int().min(1).max(8),
    label: z.string().trim().min(1).max(80),
  })
  .strict();

export const coverTemplateFactsSchema = z
  .object({
    assetId: entityIdSchema,
    checksum: hashSchema,
    pageWidthMm: finiteNumber.positive().max(2_000),
    pageHeightMm: finiteNumber.positive().max(2_000),
    backRegion: printNormalizedRegionSchema,
    spineRegion: printNormalizedRegionSchema,
    frontRegion: printNormalizedRegionSchema,
    toleranceMm: finiteNumber.min(0).max(2),
  })
  .strict()
  .superRefine((template, context) => {
    const ordered = [
      template.backRegion,
      template.spineRegion,
      template.frontRegion,
    ];
    const sameHeight = ordered.every(
      (region) =>
        Math.abs(region.y) <= 1e-9 && Math.abs(region.height - 1) <= 1e-9,
    );
    const contiguous =
      Math.abs(template.backRegion.x) <= 1e-9 &&
      Math.abs(
        template.backRegion.x +
          template.backRegion.width -
          template.spineRegion.x,
      ) <= 1e-9 &&
      Math.abs(
        template.spineRegion.x +
          template.spineRegion.width -
          template.frontRegion.x,
      ) <= 1e-9 &&
      Math.abs(template.frontRegion.x + template.frontRegion.width - 1) <= 1e-9;
    if (!sameHeight || !contiguous)
      context.addIssue({
        code: "custom",
        path: ["frontRegion"],
        message: "COVER_TEMPLATE_PANEL_GEOMETRY_INVALID",
      });
  });

const rgbColorSchema = z
  .object({
    mode: z.literal("rgb"),
    iccAssetId: z.null().optional(),
    iccChecksum: z.null().optional(),
  })
  .strict();

const cmykColorSchema = z
  .object({
    mode: z.literal("cmyk"),
    iccAssetId: entityIdSchema,
    iccChecksum: hashSchema,
  })
  .strict();

export const printerColorSchema = z.discriminatedUnion("mode", [
  rgbColorSchema,
  cmykColorSchema,
]);

const missingSpineSchema = z
  .object({ source: z.literal("missing"), widthMm: z.null() })
  .strict();
const explicitSpineSchema = z
  .object({
    source: z.literal("explicit"),
    widthMm: finiteNumber.positive().max(200),
  })
  .strict();
const templateSpineSchema = z
  .object({
    source: z.literal("template"),
    widthMm: finiteNumber.positive().max(200),
  })
  .strict();

export const printerSpineSchema = z.discriminatedUnion("source", [
  missingSpineSchema,
  explicitSpineSchema,
  templateSpineSchema,
]);

export const cropMarkSchema = z
  .object({
    enabled: z.boolean(),
    offsetMm: finiteNumber.min(0).max(30),
    lengthMm: finiteNumber.min(0).max(30),
    strokePt: finiteNumber.positive().max(5),
  })
  .strict()
  .superRefine((marks, context) => {
    const valid = marks.enabled
      ? marks.offsetMm > 0 && marks.lengthMm > 0
      : marks.offsetMm === 0 && marks.lengthMm === 0;
    if (!valid)
      context.addIssue({
        code: "custom",
        path: ["enabled"],
        message: "CROP_MARK_CONFIGURATION_INVALID",
      });
  });

export const printerProfileDraftSchema = z
  .object({
    trim: z
      .object({
        widthMm: finiteNumber.positive().max(2_000),
        heightMm: finiteNumber.positive().max(2_000),
        orientation: z.literal("portrait"),
      })
      .strict(),
    bleedMm: finiteNumber.min(0).max(30),
    safeContentRegion: printNormalizedRegionSchema,
    dpiMin: z.number().int().min(72).max(2_400),
    color: printerColorSchema,
    cropMarks: cropMarkSchema,
    spine: printerSpineSchema,
    coverTemplate: coverTemplateFactsSchema.nullable(),
    requiredBlankPages: z.array(printerBlankRuleSchema).max(2),
  })
  .strict()
  .superRefine(validateProfileMechanics);

export type PrinterProfileDraft = z.infer<typeof printerProfileDraftSchema>;

export const printerProfileSchema = z
  .object({
    ...revisionedDocument,
    name: z.string().trim().min(1).max(160),
    currentVersionId: entityIdSchema,
    archived: z.boolean(),
  })
  .strict();

export const printerProfileVersionSchema = z
  .object({
    ...baseDocument,
    profileId: entityIdSchema,
    previousVersionId: entityIdSchema.nullable(),
    trim: printerProfileDraftSchema.shape.trim,
    bleedMm: printerProfileDraftSchema.shape.bleedMm,
    safeContentRegion: printNormalizedRegionSchema,
    dpiMin: printerProfileDraftSchema.shape.dpiMin,
    color: printerColorSchema,
    cropMarks: cropMarkSchema,
    spine: printerSpineSchema,
    coverTemplate: coverTemplateFactsSchema.nullable(),
    requiredBlankPages: z.array(printerBlankRuleSchema).max(2),
    profileHash: hashSchema,
    readiness: z.enum(["ready", "incomplete"]),
    blockingReasons: z.array(codeSchema).max(20),
  })
  .strict()
  .superRefine((version, context) => {
    validateProfileMechanics(version, context);
    const draft = profileDraftFrom(version);
    const readiness = profileReadiness(draft);
    if (version.profileHash !== hashCanonical(draft))
      context.addIssue({
        code: "custom",
        path: ["profileHash"],
        message: "PRINTER_PROFILE_HASH_MISMATCH",
      });
    if (
      version.readiness !== readiness.readiness ||
      JSON.stringify(version.blockingReasons) !==
        JSON.stringify(readiness.blockingReasons)
    )
      context.addIssue({
        code: "custom",
        path: ["readiness"],
        message: "PRINTER_PROFILE_READINESS_MISMATCH",
      });
  });

export type PrinterProfile = z.infer<typeof printerProfileSchema>;
export type PrinterProfileVersion = z.infer<typeof printerProfileVersionSchema>;

export function createDefaultPrinterProfileDraft(): PrinterProfileDraft {
  return printerProfileDraftSchema.parse({
    trim: { widthMm: 210, heightMm: 297, orientation: "portrait" },
    bleedMm: 3,
    safeContentRegion: { x: 0.07, y: 0.05, width: 0.86, height: 0.9 },
    dpiMin: 300,
    color: { mode: "rgb", iccAssetId: null, iccChecksum: null },
    cropMarks: {
      enabled: false,
      offsetMm: 0,
      lengthMm: 0,
      strokePt: 0.25,
    },
    spine: { source: "missing", widthMm: null },
    coverTemplate: null,
    requiredBlankPages: [],
  });
}

export function finalizePrinterProfileVersion(input: {
  id: string;
  profileId: string;
  previousVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  draft: unknown;
}): PrinterProfileVersion {
  const draft = printerProfileDraftSchema.parse(input.draft);
  const readiness = profileReadiness(draft);
  return printerProfileVersionSchema.parse({
    id: input.id,
    schemaVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    profileId: input.profileId,
    previousVersionId: input.previousVersionId,
    ...draft,
    profileHash: hashCanonical(draft),
    ...readiness,
  });
}

export function profileReadiness(draft: PrinterProfileDraft): {
  readiness: "ready" | "incomplete";
  blockingReasons: string[];
} {
  const blockingReasons: string[] = [];
  if (draft.spine.source === "missing")
    blockingReasons.push("SPINE_WIDTH_UNKNOWN");
  if (draft.color.mode === "cmyk" && !draft.color.iccAssetId)
    blockingReasons.push("ICC_PROFILE_MISSING");
  return {
    readiness: blockingReasons.length ? "incomplete" : "ready",
    blockingReasons,
  };
}

function profileDraftFrom(
  value: Pick<
    PrinterProfileVersion,
    | "trim"
    | "bleedMm"
    | "safeContentRegion"
    | "dpiMin"
    | "color"
    | "cropMarks"
    | "spine"
    | "coverTemplate"
    | "requiredBlankPages"
  >,
): PrinterProfileDraft {
  return {
    trim: value.trim,
    bleedMm: value.bleedMm,
    safeContentRegion: value.safeContentRegion,
    dpiMin: value.dpiMin,
    color: value.color,
    cropMarks: value.cropMarks,
    spine: value.spine,
    coverTemplate: value.coverTemplate,
    requiredBlankPages: value.requiredBlankPages,
  };
}

function validateProfileMechanics(
  profile: PrinterProfileDraft,
  context: z.RefinementCtx,
): void {
  if (profile.trim.widthMm >= profile.trim.heightMm)
    context.addIssue({
      code: "custom",
      path: ["trim"],
      message: "PRINTER_PROFILE_PORTRAIT_DIMENSIONS_REQUIRED",
    });
  const positions = profile.requiredBlankPages.map((rule) => rule.position);
  if (new Set(positions).size !== positions.length)
    context.addIssue({
      code: "custom",
      path: ["requiredBlankPages"],
      message: "PRINTER_BLANK_POSITION_DUPLICATE",
    });
  if (profile.spine.source === "template") {
    const template = profile.coverTemplate;
    const templateWidth = template
      ? template.pageWidthMm * template.spineRegion.width
      : null;
    if (
      !template ||
      templateWidth === null ||
      Math.abs(templateWidth - profile.spine.widthMm) > template.toleranceMm
    )
      context.addIssue({
        code: "custom",
        path: ["spine"],
        message: "COVER_TEMPLATE_SPINE_MISMATCH",
      });
  }
  validateCoverTemplateMechanics(profile, context);
}

function validateCoverTemplateMechanics(
  profile: PrinterProfileDraft,
  context: z.RefinementCtx,
): void {
  const template = profile.coverTemplate;
  if (!template) return;
  const spineWidth = profile.spine.widthMm ?? 0;
  const expectedWidth = profile.trim.widthMm * 2 + spineWidth;
  if (
    Math.abs(template.pageWidthMm - expectedWidth) > template.toleranceMm ||
    Math.abs(template.pageHeightMm - profile.trim.heightMm) >
      template.toleranceMm
  )
    context.addIssue({
      code: "custom",
      path: ["coverTemplate"],
      message: "COVER_TEMPLATE_DIMENSIONS_MISMATCH",
    });
  const expectedPanels = [
    { region: template.backRegion, x: 0, width: profile.trim.widthMm },
    {
      region: template.spineRegion,
      x: profile.trim.widthMm,
      width: spineWidth,
    },
    {
      region: template.frontRegion,
      x: profile.trim.widthMm + spineWidth,
      width: profile.trim.widthMm,
    },
  ];
  if (
    expectedPanels.some(
      ({ region, x, width }) =>
        Math.abs(region.x * template.pageWidthMm - x) > template.toleranceMm ||
        Math.abs(region.width * template.pageWidthMm - width) >
          template.toleranceMm,
    )
  )
    context.addIssue({
      code: "custom",
      path: ["coverTemplate"],
      message: "COVER_TEMPLATE_PANEL_GEOMETRY_INVALID",
    });
}

export const printArtifactKindSchema = z.enum(["interior", "cover"]);
export const printRunStateSchema = z.enum([
  "queued",
  "producing",
  "preflight_pending",
  "converted_proof_pending",
  "deliverable",
  "blocked",
  "stale",
  "rejected",
]);

const sourceReferenceSchema = z
  .object({
    role: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
    assetId: entityIdSchema,
    checksum: hashSchema,
  })
  .strict();

export const printRunSchema = z
  .object({
    ...revisionedDocument,
    projectId: entityIdSchema,
    familyId: entityIdSchema,
    customerId: entityIdSchema,
    requestHash: hashSchema,
    idempotencyKey: z.string().trim().min(1).max(160),
    contentAuthorizationHash: hashSchema,
    approvalCycleId: entityIdSchema,
    approvalGateJobId: entityIdSchema,
    previewOutputId: entityIdSchema,
    customerContentHash: hashSchema,
    compositionProfileId: entityIdSchema,
    compositionProfileHash: hashSchema,
    printerProfileId: entityIdSchema,
    printerProfileVersionId: entityIdSchema,
    printerProfileHash: hashSchema,
    sourceSnapshotHash: hashSchema,
    sourceAssets: z.array(sourceReferenceSchema).max(200),
    state: printRunStateSchema,
    interiorJobId: entityIdSchema,
    coverJobId: entityIdSchema,
    preflightJobId: entityIdSchema.nullable(),
    convertedProofGateJobId: entityIdSchema.nullable(),
    currentInteriorArtifactId: entityIdSchema.nullable(),
    currentCoverArtifactId: entityIdSchema.nullable(),
    currentPreflightReportId: entityIdSchema.nullable(),
    convertedProofBundleHash: hashSchema.nullable(),
    blockingReasons: z.array(codeSchema).max(100),
    staleReasons: z.array(codeSchema).max(100),
    invalidatedByEventIds: z.array(entityIdSchema).max(1_000),
  })
  .strict();

export type PrintRun = z.infer<typeof printRunSchema>;

export const printArtifactSchema = z
  .object({
    ...baseDocument,
    projectId: entityIdSchema,
    runId: entityIdSchema,
    jobId: entityIdSchema,
    kind: printArtifactKindSchema,
    assetId: entityIdSchema,
    checksum: hashSchema,
    bytes: z.number().int().positive(),
    contentAuthorizationHash: hashSchema,
    printerProfileVersionId: entityIdSchema,
    printerProfileHash: hashSchema,
    sourceSnapshotHash: hashSchema,
    pageMapHash: hashSchema,
    colorMode: z.enum(["rgb", "cmyk"]),
    iccChecksum: hashSchema.nullable(),
    rendererVersion: versionSchema,
    converterVersion: versionSchema.nullable(),
    fontPolicyVersion: versionSchema,
    renderFactsHash: hashSchema,
    renderFacts: z
      .object({
        pageCount: z.number().int().min(1).max(40),
        egressRequestCount: z.literal(0),
        overflowPageNumbers: z.array(z.number().int().min(1).max(40)).max(40),
        watermarkCount: z.literal(0),
        minimumImagePpi: finiteNumber.nonnegative().max(10_000).nullable(),
        fontNames: z.array(z.string().trim().min(1).max(120)).max(20),
        panelOrder: z
          .tuple([z.literal("back"), z.literal("spine"), z.literal("front")])
          .nullable(),
      })
      .strict(),
    conversionFacts: z
      .object({
        outputConditionIdentifier: z.string().trim().min(1).max(160),
        embeddedIccChecksum: hashSchema,
        embeddedIccBytes: z
          .number()
          .int()
          .positive()
          .max(20 * 1024 * 1024),
        imageCount: z.number().int().nonnegative().max(10_000),
        contentStreamCount: z.number().int().positive().max(10_000),
        cmykOnly: z.literal(true),
        outputIntentMatches: z.literal(true),
        geometryPreserved: z.literal(true),
        fontsPreserved: z.literal(true),
      })
      .strict()
      .nullable(),
    reusedFromArtifactId: entityIdSchema.nullable(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (
      (artifact.colorMode === "cmyk") !==
        (artifact.iccChecksum !== null && artifact.conversionFacts !== null) ||
      (artifact.kind === "cover") !== (artifact.renderFacts.panelOrder !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["conversionFacts"],
        message: "PRINT_ARTIFACT_FACT_STATE_MISMATCH",
      });
  });

export type PrintArtifact = z.infer<typeof printArtifactSchema>;

export const printFindingSchema = z
  .object({
    code: codeSchema,
    artifact: z.enum(["interior", "cover", "preview", "bundle"]),
    page: z.number().int().positive().nullable(),
    severity: z.literal("blocking"),
    expected: z.union([z.string().max(240), finiteNumber, z.boolean()]),
    actual: z.union([z.string().max(240), finiteNumber, z.boolean()]),
  })
  .strict();

export type PrintFinding = z.infer<typeof printFindingSchema>;

export const printPreflightReportSchema = z
  .object({
    ...baseDocument,
    projectId: entityIdSchema,
    runId: entityIdSchema,
    interiorArtifactId: entityIdSchema,
    interiorChecksum: hashSchema,
    coverArtifactId: entityIdSchema,
    coverChecksum: hashSchema,
    contentAuthorizationHash: hashSchema,
    printerProfileVersionId: entityIdSchema,
    printerProfileHash: hashSchema,
    policyVersion: versionSchema,
    toolVersions: z.record(z.string().max(40), z.string().max(120)),
    findings: z.array(printFindingSchema).max(500),
    measurements: z
      .object({
        pageMap: z
          .array(
            z
              .object({
                outputPageNumber: z.number().int().positive().max(40),
                kind: z.enum(["customer", "printer_blank"]),
                customerPageNumber: z
                  .number()
                  .int()
                  .positive()
                  .max(24)
                  .nullable(),
                pageId: entityIdSchema.nullable(),
                label: z.string().trim().min(1).max(80).nullable(),
              })
              .strict(),
          )
          .max(40),
        interior: persistedPdfFactsSchema,
        cover: persistedPdfFactsSchema,
        sourceAssets: z.array(sourceReferenceSchema).max(200),
        outputChecksums: z
          .object({ interior: hashSchema, cover: hashSchema })
          .strict(),
        coverSpread: z
          .object({
            panelOrder: z.tuple([
              z.literal("back"),
              z.literal("spine"),
              z.literal("front"),
            ]),
            spineWidthMm: finiteNumber.positive().max(200),
            panels: z
              .array(
                z
                  .object({
                    kind: z.enum(["back", "spine", "front"]),
                    boxMm: z
                      .object({
                        x: finiteNumber,
                        y: finiteNumber,
                        width: finiteNumber.positive(),
                        height: finiteNumber.positive(),
                      })
                      .strict(),
                  })
                  .strict(),
              )
              .length(3),
            foldLinesMm: z.array(finiteNumber).length(2),
          })
          .strict(),
        cropMarks: z
          .object({
            enabled: z.boolean(),
            offsetMm: finiteNumber.min(0).max(30),
            lengthMm: finiteNumber.min(0).max(30),
            strokePt: finiteNumber.positive().max(5),
            interiorSegmentCount: z.number().int().min(0).max(8),
            coverSegmentCount: z.number().int().min(0).max(8),
          })
          .strict(),
        colorMode: z.enum(["rgb", "cmyk"]),
        iccChecksum: hashSchema.nullable(),
        outputIntentMatches: z.boolean(),
      })
      .strict(),
    measurementsHash: hashSchema,
    passed: z.boolean(),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.passed !== (report.findings.length === 0))
      context.addIssue({
        code: "custom",
        path: ["passed"],
        message: "PRINT_PREFLIGHT_STATE_MISMATCH",
      });
    if (report.measurementsHash !== hashCanonical(report.measurements))
      context.addIssue({
        code: "custom",
        path: ["measurementsHash"],
        message: "PRINT_PREFLIGHT_MEASUREMENTS_HASH_MISMATCH",
      });
  });

export type PrintPreflightReport = z.infer<typeof printPreflightReportSchema>;

export const printProofBundleSchema = z
  .object({
    ...baseDocument,
    projectId: entityIdSchema,
    runId: entityIdSchema,
    gateJobId: entityIdSchema,
    interiorArtifactId: entityIdSchema,
    interiorChecksum: hashSchema,
    coverArtifactId: entityIdSchema,
    coverChecksum: hashSchema,
    iccChecksum: hashSchema,
    printerProfileHash: hashSchema,
    contentAuthorizationHash: hashSchema,
    representativeAssets: z
      .array(
        z
          .object({
            kind: z.enum(["interior", "cover"]),
            assetId: entityIdSchema,
            checksum: hashSchema,
          })
          .strict(),
      )
      .length(2)
      .refine(
        (assets) =>
          new Set(assets.map((asset) => asset.kind)).size === assets.length,
        "PRINT_PROOF_REPRESENTATIVE_DUPLICATE",
      ),
    bundleHash: hashSchema,
  })
  .strict();

export type PrintProofBundle = z.infer<typeof printProofBundleSchema>;

export const convertedProofActionSchema = z
  .object({
    ...baseDocument,
    runId: entityIdSchema,
    gateJobId: entityIdSchema,
    ownerCustomerId: entityIdSchema,
    ownerFamilyId: entityIdSchema,
    action: z.enum(["approved", "rejected"]),
    idempotencyKey: z.string().trim().min(1).max(160),
    canonicalRequestHash: hashSchema,
    expectedRunRevision: z.number().int().nonnegative(),
    expectedGateRevision: z.number().int().nonnegative(),
    proofBundleHash: hashSchema,
    contentAuthorizationHash: hashSchema,
    printerProfileHash: hashSchema,
    iccChecksum: hashSchema,
    normalizedNotes: z.string().max(1_000),
    resultRunRevision: z.number().int().nonnegative(),
    resultGateRevision: z.number().int().nonnegative(),
    recordedAt: timestampSchema,
  })
  .strict();

export type ConvertedProofAction = z.infer<typeof convertedProofActionSchema>;
