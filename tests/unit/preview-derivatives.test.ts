import { describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  createPreviewImageDerivative,
  createPreviewPageThumbnail,
  previewDerivativePolicyHash,
} from "../../src/pdf/preview-derivatives.js";
import { syntheticPreviewSource } from "../helpers/preview-fixtures.js";

describe("preview image derivatives", () => {
  it("creates byte-deterministic placed-size JPEGs at the pinned target PPI", async () => {
    const sourceBytes = await syntheticPreviewSource();
    const request = {
      sourceBytes,
      placedWidthMm: 100,
      placedHeightMm: 140,
      fit: "cover" as const,
    };
    const first = await createPreviewImageDerivative(request);
    const second = await createPreviewImageDerivative(request);

    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(first.policyHash).toBe(previewDerivativePolicyHash);
    expect(first).toMatchObject({
      mime: "image/jpeg",
      widthPx: 591,
      heightPx: 827,
    });
    expect(first.xPpi).toBeCloseTo(150, 0);
    expect(first.yPpi).toBeCloseTo(150, 0);
    const metadata = await sharp(first.bytes).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  it("makes deterministic bounded thumbnails from an already-watermarked page raster", async () => {
    const pageRaster = await syntheticPreviewSource();
    const first = await createPreviewPageThumbnail(pageRaster);
    const second = await createPreviewPageThumbnail(pageRaster);

    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(first.widthPx).toBeLessThanOrEqual(320);
    expect(first.heightPx).toBeLessThanOrEqual(452);
    expect(first.mime).toBe("image/jpeg");
  });

  it("refuses to upscale a source that cannot meet the fixed preview policy", async () => {
    const sourceBytes = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: "#fff8e8",
      },
    })
      .png()
      .toBuffer();

    await expect(
      createPreviewImageDerivative({
        sourceBytes,
        placedWidthMm: 210,
        placedHeightMm: 297,
      }),
    ).rejects.toThrow("PREVIEW_SOURCE_RESOLUTION_TOO_LOW");
  });

  it("supports contained placement and rejects empty or impossible requests", async () => {
    const sourceBytes = await syntheticPreviewSource();
    const contained = await createPreviewImageDerivative({
      sourceBytes,
      placedWidthMm: 100,
      placedHeightMm: 140,
      fit: "contain",
    });
    expect(contained).toMatchObject({ widthPx: 591, heightPx: 827 });

    for (const [placedWidthMm, placedHeightMm] of [
      [Number.NaN, 100],
      [0, 100],
      [100, 1_001],
    ])
      await expect(
        createPreviewImageDerivative({
          sourceBytes,
          placedWidthMm,
          placedHeightMm,
        }),
      ).rejects.toThrow("PREVIEW_PLACEMENT_DIMENSIONS_INVALID");
    await expect(createPreviewPageThumbnail(new Uint8Array())).rejects.toThrow(
      "PREVIEW_IMAGE_SOURCE_INVALID",
    );
  });
});
