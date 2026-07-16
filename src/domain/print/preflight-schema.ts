import { z } from "zod";

const finiteNumber = z.number().finite();
const pageNumber = z.number().int().positive().max(40);

const millimeterBoxSchema = z
  .object({
    x: finiteNumber,
    y: finiteNumber,
    width: finiteNumber.positive(),
    height: finiteNumber.positive(),
  })
  .strict();

const pageBoxSchema = z
  .object({
    pageNumber,
    rotation: finiteNumber.min(-3_600).max(3_600).nullable(),
    mediaBoxMm: millimeterBoxSchema.nullable(),
    bleedBoxMm: millimeterBoxSchema.nullable(),
    trimBoxMm: millimeterBoxSchema.nullable(),
    portrait: z.boolean(),
  })
  .strict();

const pageImageSchema = z
  .object({
    pageNumber,
    imageCount: z.number().int().positive().max(10_000),
    minimumPpi: finiteNumber.nonnegative().max(10_000).nullable(),
  })
  .strict();

const pageTextBoundsSchema = z
  .object({
    pageNumber,
    wordCount: z.number().int().nonnegative().max(1_000_000),
    boundsMm: millimeterBoxSchema.nullable(),
    unsafeWordCount: z.number().int().nonnegative().max(1_000_000),
    firstUnsafeWordBoundsMm: millimeterBoxSchema.nullable(),
  })
  .strict()
  .superRefine((page, context) => {
    if (page.unsafeWordCount === 0 && page.firstUnsafeWordBoundsMm !== null)
      context.addIssue({
        code: "custom",
        path: ["firstUnsafeWordBoundsMm"],
        message: "PRINT_PREFLIGHT_UNSAFE_WORD_EVIDENCE_UNEXPECTED",
      });
    if (page.unsafeWordCount > 0 && page.firstUnsafeWordBoundsMm === null)
      context.addIssue({
        code: "custom",
        path: ["firstUnsafeWordBoundsMm"],
        message: "PRINT_PREFLIGHT_UNSAFE_WORD_EVIDENCE_MISSING",
      });
    if (page.unsafeWordCount > page.wordCount)
      context.addIssue({
        code: "custom",
        path: ["unsafeWordCount"],
        message: "PRINT_PREFLIGHT_UNSAFE_WORD_COUNT_INVALID",
      });
  });

const pageCropMarkSchema = z
  .object({
    pageNumber,
    detectedSegmentCount: z.number().int().min(0).max(8),
  })
  .strict();

export const persistedPdfFactsSchema = z
  .object({
    pageCount: z.number().int().nonnegative().max(40),
    encrypted: z.boolean(),
    parseable: z.boolean(),
    mediaBoxMm: millimeterBoxSchema.nullable(),
    bleedBoxMm: millimeterBoxSchema.nullable(),
    trimBoxMm: millimeterBoxSchema.nullable(),
    pageBoxes: z.array(pageBoxSchema).max(40),
    fonts: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(120),
            embedded: z.boolean(),
            subset: z.boolean(),
            toUnicode: z.boolean(),
          })
          .strict(),
      )
      .max(40),
    imageCount: z.number().int().nonnegative().max(10_000),
    imagePpi: z.array(pageImageSchema).max(40),
    minimumImagePpi: finiteNumber.nonnegative().max(10_000).nullable(),
    textBounds: z.array(pageTextBoundsSchema).max(40),
    cropMarkSegments: z.array(pageCropMarkSchema).max(40),
    hasArabicText: z.boolean(),
    arabicGlyphCount: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024),
    unmappedGlyphCount: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024),
    watermarkCount: z.number().int().nonnegative().max(1_000),
    watermarkPages: z.array(pageNumber).max(40),
    prohibitedFeatureCount: z.number().int().nonnegative().max(1_000),
    externalResourceCount: z.number().int().nonnegative().max(1_000),
    hasDeviceRgb: z.boolean(),
    hasDeviceCmyk: z.boolean(),
  })
  .strict()
  .superRefine((facts, context) => {
    for (const [field, required] of [
      ["pageBoxes", facts.parseable],
      ["textBounds", facts.parseable],
      ["cropMarkSegments", facts.parseable],
      ["imagePpi", false],
    ] as const) {
      const pages = facts[field];
      if (
        (required && pages.length !== facts.pageCount) ||
        pages.some(
          (page, index) =>
            page.pageNumber > facts.pageCount ||
            (index > 0 && page.pageNumber <= pages[index - 1].pageNumber),
        )
      )
        context.addIssue({
          code: "custom",
          path: [field],
          message:
            field === "pageBoxes"
              ? "PRINT_PREFLIGHT_PAGE_BOX_FACTS_INVALID"
              : field === "imagePpi"
                ? "PRINT_PREFLIGHT_IMAGE_PPI_FACTS_INVALID"
                : "PRINT_PREFLIGHT_PAGE_FACTS_INVALID",
        });
    }
    if (
      facts.watermarkPages.some(
        (page, index) =>
          page > facts.pageCount ||
          (index > 0 && page <= facts.watermarkPages[index - 1]),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["watermarkPages"],
        message: "PRINT_PREFLIGHT_WATERMARK_PAGE_FACTS_INVALID",
      });
  });
