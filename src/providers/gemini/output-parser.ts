import sharp from "sharp";

import { imageResultSchema, type ImageResult } from "../contract.js";
import { makeFailure, type NormalizedFailure } from "../failures.js";
import type { GeminiTransportResponse } from "./client.js";

export type GeminiOutputResult<T> =
  { ok: true; value: T } | { ok: false; failure: NormalizedFailure };

export function parseGeminiText(
  response: GeminiTransportResponse,
): GeminiOutputResult<string> {
  if (response.safetyBlocked) return safetyFailure();
  if (response.candidateCount !== 1) return malformed();
  if (response.parts.some((part) => part.inlineData)) return malformed();
  const text = response.parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  return text ? { ok: true, value: text } : malformed();
}

export async function parseGeminiImage(
  response: GeminiTransportResponse,
  minimum: { width: number; height: number },
): Promise<GeminiOutputResult<ImageResult>> {
  if (response.safetyBlocked) return safetyFailure();
  if (response.candidateCount !== 1) return malformed();
  const images = response.parts.filter((part) => part.inlineData);
  const hasText = response.parts.some((part) => Boolean(part.text?.trim()));
  if (images.length !== 1 || hasText) return malformed();
  const inline = images[0]?.inlineData;
  const bytes = decodeBase64(inline?.data);
  const declared = inline?.mimeType;
  const sniffed = bytes ? sniffImageMime(bytes) : null;
  if (!bytes || !sniffed || declared !== sniffed) return malformed();
  try {
    const metadata = await sharp(bytes).metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width < minimum.width ||
      metadata.height < minimum.height
    ) {
      return malformed();
    }
    return {
      ok: true,
      value: imageResultSchema.parse({
        imageBytes: new Uint8Array(bytes),
        mime: sniffed,
        providerMeta: safeProviderMeta(response),
      }),
    };
  } catch {
    return malformed();
  }
}

function decodeBase64(value: string | undefined): Buffer | null {
  if (!value || value.length > 140 * 1024 * 1024) return null;
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength > 0 ? bytes : null;
}

function sniffImageMime(
  bytes: Buffer,
): "image/png" | "image/jpeg" | "image/webp" | null {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function safeProviderMeta(response: GeminiTransportResponse) {
  return {
    responseId: safeIdentifier(response.responseId),
    modelVersion: safeIdentifier(response.modelVersion),
    finishReason: safeIdentifier(response.finishReason),
    safetyRatings: response.safetyRatings.slice(0, 20).map((rating) => ({
      category: safeIdentifier(rating.category) ?? "unknown",
      blocked: rating.blocked,
    })),
  };
}

function safeIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 160);
  return normalized || undefined;
}

function malformed<T>(): GeminiOutputResult<T> {
  return { ok: false, failure: makeFailure("malformed_output") };
}

function safetyFailure<T>(): GeminiOutputResult<T> {
  return { ok: false, failure: makeFailure("safety_refusal") };
}
