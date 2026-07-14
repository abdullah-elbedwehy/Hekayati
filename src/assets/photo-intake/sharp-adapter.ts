import sharp, { type Sharp } from "sharp";

import { normalizePhotoIntakeError, PhotoIntakeError } from "./errors.js";
import { photoQualityPolicyV1 } from "./quality.js";
import { SipsHeicConverter } from "./sips-heic-converter.js";
import { toPixelCrop } from "./subject-selection.js";
import type {
  HeicConverter,
  ImageDerivationRequest,
  ImageInspection,
  ImageInspectionRequest,
  ImageSubjectCropRequest,
  LocalImageMetrics,
  LocalPhotoImageAdapter,
  PhotoBaseDerivativeSet,
  SafePhotoDerivative,
} from "./types.js";

export class SharpLocalPhotoImageAdapter implements LocalPhotoImageAdapter {
  constructor(
    private readonly heicConverter: HeicConverter = new SipsHeicConverter(),
  ) {}

  async inspect(request: ImageInspectionRequest): Promise<ImageInspection> {
    let converted: Buffer | undefined;
    try {
      converted = await this.convertIfRequired(request);
      const decoderInput = converted ?? request.bytes;
      const metadata = await sharp(decoderInput, {
        failOn: "error",
        limitInputPixels: false,
        sequentialRead: true,
      }).metadata();
      const oriented = metadata.autoOrient ?? metadata;
      if (!oriented.width || !oriented.height)
        throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
      return { widthPx: oriented.width, heightPx: oriented.height };
    } catch (error) {
      throw normalizePhotoIntakeError(error);
    } finally {
      wipeConverted(converted, request.bytes);
    }
  }

  async deriveBase(
    request: ImageDerivationRequest,
  ): Promise<PhotoBaseDerivativeSet> {
    let converted: Buffer | undefined;
    const allocated: Buffer[] = [];
    try {
      converted = await this.convertIfRequired(request);
      const decoderInput = converted ?? request.bytes;
      const working = await createWorking(decoderInput, request.maxPixels);
      allocated.push(working.bytes);
      const thumbnail = await createThumbnail(working);
      allocated.push(thumbnail.bytes);
      const metrics = await measureLocalMetrics(working.bytes);
      await Promise.all([
        assertMetadataClean(working),
        assertMetadataClean(thumbnail),
      ]);
      return { working, thumbnail, metrics };
    } catch (error) {
      for (const bytes of allocated) bytes.fill(0);
      throw normalizePhotoIntakeError(error);
    } finally {
      wipeConverted(converted, request.bytes);
    }
  }

  async deriveSubjectCrop(
    request: ImageSubjectCropRequest,
  ): Promise<SafePhotoDerivative> {
    try {
      const crop = toPixelCrop(
        request.subjectSelection,
        request.working.widthPx,
        request.working.heightPx,
      );
      const result = await encodeJpeg(
        sharp(request.working.bytes, { failOn: "error" }).extract(crop),
      );
      await assertMetadataClean(result);
      return result;
    } catch (error) {
      throw normalizePhotoIntakeError(error);
    }
  }

  private async convertIfRequired(
    request: ImageInspectionRequest,
  ): Promise<Buffer | undefined> {
    return request.detectedType.format === "heic"
      ? this.heicConverter.convertToPng(request.bytes, request.maxPixels)
      : undefined;
  }
}

function wipeConverted(converted: Buffer | undefined, original: Buffer): void {
  if (converted && converted !== original) converted.fill(0);
}

async function createWorking(
  bytes: Buffer,
  maxPixels: number,
): Promise<SafePhotoDerivative> {
  const pipeline = sharp(bytes, {
    failOn: "error",
    limitInputPixels: maxPixels,
    sequentialRead: true,
  })
    .rotate()
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb");
  return encodeJpeg(pipeline);
}

async function createThumbnail(
  working: SafePhotoDerivative,
): Promise<SafePhotoDerivative> {
  const { data, info } = await sharp(working.bytes, { failOn: "error" })
    .resize({
      width: 384,
      height: 384,
      fit: "inside",
      withoutEnlargement: true,
    })
    // A small source may not be resized. Use a thumbnail-specific encoding so
    // its content address remains distinct from the full working derivative.
    .jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: "4:2:0" })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: data,
    mime: "image/jpeg",
    extension: "jpg",
    widthPx: info.width,
    heightPx: info.height,
    metadataStripped: true,
  };
}

async function encodeJpeg(pipeline: Sharp): Promise<SafePhotoDerivative> {
  const { data, info } = await pipeline
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: data,
    mime: "image/jpeg",
    extension: "jpg",
    widthPx: info.width,
    heightPx: info.height,
    metadataStripped: true,
  };
}

async function measureLocalMetrics(bytes: Buffer): Promise<LocalImageMetrics> {
  const { data, info } = await sharp(bytes, { failOn: "error" })
    .resize({
      width: photoQualityPolicyV1.evaluationMaxDimensionPx,
      height: photoQualityPolicyV1.evaluationMaxDimensionPx,
      fit: "inside",
      withoutEnlargement: true,
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const values = singleChannel(data, info.channels);
  return {
    blurScore: round(laplacianVariance(values, info.width, info.height)),
    exposureScore: round(mean(values) / 255),
    shadowFraction: round(countBelow(values, 32) / values.length),
  };
}

function singleChannel(bytes: Buffer, channels: number): Uint8Array {
  if (channels === 1) return bytes;
  const result = new Uint8Array(Math.ceil(bytes.length / channels));
  for (let source = 0, target = 0; source < bytes.length; source += channels)
    result[target++] = bytes[source]!;
  return result;
}

function laplacianVariance(
  values: Uint8Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0;
  const samples: number[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const center = values[y * width + x];
      samples.push(
        values[(y - 1) * width + x] +
          values[(y + 1) * width + x] +
          values[y * width + x - 1] +
          values[y * width + x + 1] -
          4 * center,
      );
    }
  }
  return variance(samples);
}

function mean(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (let index = 0; index < values.length; index += 1) total += values[index];
  return total / values.length;
}

function variance(values: readonly number[]): number {
  const average = mean(values);
  let squared = 0;
  for (const value of values) squared += (value - average) ** 2;
  return values.length === 0 ? 0 : squared / values.length;
}

function countBelow(values: Uint8Array, threshold: number): number {
  let count = 0;
  for (const value of values) if (value < threshold) count += 1;
  return count;
}

async function assertMetadataClean(value: SafePhotoDerivative): Promise<void> {
  const metadata = await sharp(value.bytes, { failOn: "error" }).metadata();
  if (
    metadata.orientation !== undefined ||
    metadata.exif !== undefined ||
    metadata.iptc !== undefined ||
    metadata.xmp !== undefined ||
    metadata.tifftagPhotoshop !== undefined ||
    metadata.comments !== undefined
  )
    throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
