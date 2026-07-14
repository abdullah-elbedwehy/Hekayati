import { createHash } from "node:crypto";

import { readBoundedPhoto } from "./byte-source.js";
import { PhotoIntakeError, normalizePhotoIntakeError } from "./errors.js";
import { PreparedPhoto, StagedPhoto } from "./prepared-photo.js";
import { evaluatePhotoQuality } from "./quality.js";
import { sniffSupportedPhoto } from "./sniff.js";
import { toPixelCrop, validateSubjectSelection } from "./subject-selection.js";
import type {
  FinalizePhotoInput,
  ImageInspection,
  LocalPhotoImageAdapter,
  PhotoBaseDerivativeSet,
  PhotoQualityMetrics,
  PreparePhotoInput,
  PreparedPhotoValue,
  SafePhotoDerivative,
  StagePhotoInput,
  StagedPhotoValue,
  SubjectRectangle,
} from "./types.js";

export class PhotoIntakeProcessor {
  constructor(private readonly imageAdapter: LocalPhotoImageAdapter) {}

  async stage(input: StagePhotoInput): Promise<StagedPhoto> {
    validateLimits(input);
    let exact: Buffer | undefined;
    let derivatives: PhotoBaseDerivativeSet | undefined;
    try {
      exact = await readBoundedPhoto(input.source, input.limits.maxBytes);
      const detectedType = await sniffSupportedPhoto(exact);
      const inspection = await this.imageAdapter.inspect({
        bytes: exact,
        detectedType,
        maxPixels: input.limits.maxPixels,
      });
      assertPixelLimit(inspection, input.limits.maxPixels);
      derivatives = await this.imageAdapter.deriveBase({
        bytes: exact,
        detectedType,
        maxPixels: input.limits.maxPixels,
      });
      assertBaseDerivatives(derivatives, inspection);
      return new StagedPhoto(
        buildStagedValue(input, exact, detectedType, derivatives),
      );
    } catch (error) {
      exact?.fill(0);
      wipeBaseDerivatives(derivatives);
      throw normalizePhotoIntakeError(error);
    }
  }

  async finalize(
    staged: StagedPhoto,
    input: FinalizePhotoInput,
  ): Promise<PreparedPhoto> {
    const value = staged.value;
    const subject = validateSubjectSelection(
      value.kind,
      input.subjectSelection,
    );
    let crop: SafePhotoDerivative | undefined;
    try {
      crop = await this.createSubjectCrop(value, subject);
      const prepared = buildPreparedValue(value, crop, subject, input);
      staged.transferOwnership();
      return new PreparedPhoto(prepared);
    } catch (error) {
      crop?.bytes.fill(0);
      throw normalizePhotoIntakeError(error);
    }
  }

  async prepare(input: PreparePhotoInput): Promise<PreparedPhoto> {
    const staged = await this.stage(input);
    try {
      return await this.finalize(staged, input);
    } catch (error) {
      staged.cleanup();
      throw error;
    }
  }

  private async createSubjectCrop(
    staged: StagedPhotoValue,
    subject?: SubjectRectangle,
  ): Promise<SafePhotoDerivative | undefined> {
    if (!subject) return undefined;
    const pixelCrop = toPixelCrop(
      subject,
      staged.working.widthPx,
      staged.working.heightPx,
    );
    if (
      pixelCrop.left === 0 &&
      pixelCrop.top === 0 &&
      pixelCrop.width === staged.working.widthPx &&
      pixelCrop.height === staged.working.heightPx
    )
      throw new PhotoIntakeError("PHOTO_SUBJECT_SELECTION_REQUIRED");
    const crop = await this.imageAdapter.deriveSubjectCrop({
      working: staged.working,
      subjectSelection: subject,
    });
    assertDerivative(crop);
    assertCropDimensions(crop, staged.working, subject);
    return crop;
  }
}

function buildStagedValue(
  input: StagePhotoInput,
  exact: Buffer,
  detectedType: Awaited<ReturnType<typeof sniffSupportedPhoto>>,
  derivatives: PhotoBaseDerivativeSet,
): StagedPhotoValue {
  const metrics = qualityMetrics(derivatives);
  return {
    kind: input.kind,
    original: {
      bytes: exact,
      sha256: createHash("sha256").update(exact).digest("hex"),
      ...detectedType,
    },
    working: derivatives.working,
    thumbnail: derivatives.thumbnail,
    workingDimensions: dimensions(derivatives.working),
    preliminaryQuality: evaluatePhotoQuality({ metrics }),
  };
}

function buildPreparedValue(
  staged: StagedPhotoValue,
  crop: SafePhotoDerivative | undefined,
  subject: SubjectRectangle | undefined,
  input: FinalizePhotoInput,
): PreparedPhotoValue {
  const provider = crop ?? staged.working;
  const metrics = {
    ...staged.preliminaryQuality.metrics,
    subjectBoxAreaRatio: subject
      ? round(subject.width * subject.height)
      : undefined,
  };
  return {
    ...staged,
    subjectSelection: subject,
    subjectCrop: crop,
    providerDerivative: crop ? "subject_crop" : "working",
    providerDimensions: dimensions(provider),
    quality: evaluatePhotoQuality({
      metrics,
      observations: input.observations,
      existingObservations: input.existingObservations,
      referenceCountAfterCommit: input.referenceCountAfterCommit,
    }),
  };
}

function validateLimits(input: StagePhotoInput): void {
  if (
    !Number.isSafeInteger(input.limits.maxPixels) ||
    input.limits.maxPixels <= 0
  )
    throw new Error("INVALID_PHOTO_PIXEL_LIMIT");
}

function assertPixelLimit(
  inspection: ImageInspection,
  maxPixels: number,
): void {
  assertDimensions(inspection.widthPx, inspection.heightPx);
  if (
    BigInt(inspection.widthPx) * BigInt(inspection.heightPx) >
    BigInt(maxPixels)
  )
    throw new PhotoIntakeError("PHOTO_PIXEL_LIMIT_EXCEEDED");
}

function assertBaseDerivatives(
  value: PhotoBaseDerivativeSet,
  inspection: ImageInspection,
): void {
  assertDerivative(value.working);
  assertDerivative(value.thumbnail);
  if (
    value.working.widthPx !== inspection.widthPx ||
    value.working.heightPx !== inspection.heightPx
  )
    throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
  assertMetric(value.metrics.blurScore, 0);
  assertMetric(value.metrics.exposureScore, 0, 1);
  assertMetric(value.metrics.shadowFraction, 0, 1);
}

function assertDerivative(value: SafePhotoDerivative): void {
  assertDimensions(value.widthPx, value.heightPx);
  if (
    !Buffer.isBuffer(value.bytes) ||
    value.bytes.byteLength === 0 ||
    value.mime !== "image/jpeg" ||
    value.extension !== "jpg" ||
    value.metadataStripped !== true
  )
    throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
}

function assertCropDimensions(
  crop: SafePhotoDerivative,
  working: SafePhotoDerivative,
  subject: SubjectRectangle,
): void {
  const expected = toPixelCrop(subject, working.widthPx, working.heightPx);
  if (crop.widthPx !== expected.width || crop.heightPx !== expected.height)
    throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
}

function assertDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  )
    throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
}

function assertMetric(
  value: number,
  min: number,
  max = Number.MAX_VALUE,
): void {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
}

function qualityMetrics(value: PhotoBaseDerivativeSet): PhotoQualityMetrics {
  return {
    widthPx: value.working.widthPx,
    heightPx: value.working.heightPx,
    ...value.metrics,
  };
}

function dimensions(value: SafePhotoDerivative) {
  return { widthPx: value.widthPx, heightPx: value.heightPx };
}

function wipeBaseDerivatives(value?: PhotoBaseDerivativeSet): void {
  value?.working.bytes.fill(0);
  value?.thumbnail.bytes.fill(0);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
