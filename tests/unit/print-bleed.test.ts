import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  createPrintBleedImageCache,
  extendPrintImageForBleed,
} from "../../src/pdf/print-bleed.js";
import type { PrintDocumentImage } from "../../src/pdf/print-document.js";

describe("deterministic print bleed extension", () => {
  it("center-crops like object-fit cover and copies asymmetric edge pixels without upscaling", async () => {
    const source = await patternedPng();
    const cache = createPrintBleedImageCache();
    const input = {
      image: source,
      trimBoxMm: { width: 100, height: 100 },
      marginsMm: { top: 5, right: 20, bottom: 15, left: 10 },
      cache,
    };

    const extended = await extendPrintImageForBleed(input);
    const replay = await extendPrintImageForBleed(input);

    expect(replay).toBe(extended);
    expect(cache.size).toBe(1);
    expect(extended).toMatchObject({
      mime: "image/png",
      widthPx: 156,
      heightPx: 144,
    });
    const metadata = await sharp(extended.bytes).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 156, height: 144 });
    const pixels = await sharp(extended.bytes).removeAlpha().raw().toBuffer();
    expect(pixel(pixels, 156, 12, 6)).toEqual(sourcePixel(0, 40));
    expect(pixel(pixels, 156, 12, 0)).toEqual(sourcePixel(0, 40));
    expect(pixel(pixels, 156, 0, 16)).toEqual(sourcePixel(0, 50));
    expect(pixel(pixels, 156, 155, 16)).toEqual(sourcePixel(119, 50));
    expect(pixel(pixels, 156, 62, 143)).toEqual(sourcePixel(50, 159));
  });

  it("preserves JPEG family and fails closed on decoded dimension mismatch", async () => {
    const png = await patternedPng();
    const jpegBytes = await sharp(png.bytes)
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
      .toBuffer();
    const jpeg = { ...png, bytes: jpegBytes, mime: "image/jpeg" as const };
    const cache = createPrintBleedImageCache();
    const extended = await extendPrintImageForBleed({
      image: jpeg,
      trimBoxMm: { width: 60, height: 100 },
      marginsMm: { top: 3, right: 3, bottom: 3, left: 3 },
      cache,
    });
    expect((await sharp(extended.bytes).metadata()).format).toBe("jpeg");

    await expect(
      extendPrintImageForBleed({
        image: { ...jpeg, widthPx: jpeg.widthPx - 1 },
        trimBoxMm: { width: 60, height: 100 },
        marginsMm: { top: 3, right: 3, bottom: 3, left: 3 },
        cache,
      }),
    ).rejects.toThrow("PRINT_BLEED_EXTENSION_FAILED");
    expect(cache.size).toBe(1);
  });
});

async function patternedPng(): Promise<PrintDocumentImage> {
  const widthPx = 120;
  const heightPx = 200;
  const pixels = Buffer.alloc(widthPx * heightPx * 3);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 1) {
      const offset = (y * widthPx + x) * 3;
      pixels[offset] = x;
      pixels[offset + 1] = y;
      pixels[offset + 2] = (x + y) % 256;
    }
  }
  return {
    bytes: await sharp(pixels, {
      raw: { width: widthPx, height: heightPx, channels: 3 },
    })
      .png()
      .toBuffer(),
    mime: "image/png",
    widthPx,
    heightPx,
    assetId: "01J00000000000000000000001",
    checksum: "a".repeat(64),
    effectivePpi: 300,
  };
}

function sourcePixel(x: number, y: number): number[] {
  return [x, y, (x + y) % 256];
}

function pixel(bytes: Buffer, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 3;
  return [bytes[offset], bytes[offset + 1], bytes[offset + 2]];
}
