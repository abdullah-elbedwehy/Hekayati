import { fileTypeFromBuffer } from "file-type";

import { PhotoIntakeError } from "./errors.js";
import type { DetectedPhotoType } from "./types.js";

const jpegType: DetectedPhotoType = {
  format: "jpeg",
  mime: "image/jpeg",
  extension: "jpg",
};
const pngType: DetectedPhotoType = {
  format: "png",
  mime: "image/png",
  extension: "png",
};
const heicType: DetectedPhotoType = {
  format: "heic",
  mime: "image/heic",
  extension: "heic",
};
const heifType: DetectedPhotoType = {
  format: "heic",
  mime: "image/heif",
  extension: "heif",
};

export async function sniffSupportedPhoto(
  bytes: Uint8Array,
): Promise<DetectedPhotoType> {
  const detected = await safeFileType(bytes);
  if (detected) {
    const supported = mapDetected(detected.mime, detected.ext);
    if (supported) return supported;
    throw new PhotoIntakeError("PHOTO_UNSUPPORTED_TYPE");
  }
  const fallback = sniffSignature(bytes);
  if (fallback) return fallback;
  throw new PhotoIntakeError("PHOTO_UNSUPPORTED_TYPE");
}

async function safeFileType(
  bytes: Uint8Array,
): Promise<{ mime: string; ext: string } | undefined> {
  try {
    return await fileTypeFromBuffer(bytes);
  } catch {
    return undefined;
  }
}

function mapDetected(
  mime: string,
  extension: string,
): DetectedPhotoType | null {
  if (mime === "image/jpeg") return jpegType;
  if (mime === "image/png") return pngType;
  if (mime === "image/heic") return heicType;
  if (mime === "image/heif") return heifType;
  if (extension === "heic") return heicType;
  if (extension === "heif") return heifType;
  return null;
}

function sniffSignature(bytes: Uint8Array): DetectedPhotoType | null {
  if (isJpeg(bytes)) return jpegType;
  if (isPng(bytes)) return pngType;
  return sniffHeicBrand(bytes);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((byte, index) => bytes[index] === byte);
}

function sniffHeicBrand(bytes: Uint8Array): DetectedPhotoType | null {
  if (ascii(bytes, 4, 8) !== "ftyp") return null;
  const brands = [ascii(bytes, 8, 12)];
  for (let index = 16; index + 4 <= Math.min(bytes.length, 64); index += 4)
    brands.push(ascii(bytes, index, index + 4));
  if (brands.some((brand) => ["heic", "heix", "hevc", "hevx"].includes(brand)))
    return heicType;
  return brands.some((brand) => ["mif1", "msf1"].includes(brand))
    ? heifType
    : null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString("ascii");
}
