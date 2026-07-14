import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  PhotoIntakeProcessor,
  SharpLocalPhotoImageAdapter,
  SipsHeicConverter,
  type HeicConverter,
} from "../../src/assets/photo-intake/index.js";
import { temporaryDirectory } from "../helpers/temp.js";

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("Sharp local photo processing", () => {
  it("converts HEIC before inspection when sharp cannot decode the original", async () => {
    const invalidHeic = Buffer.from(
      "000000186674797068656963000000006d69663168656963",
      "hex",
    );
    const localPng = await sharp({
      create: {
        width: 23,
        height: 17,
        channels: 3,
        background: "#f5a623",
      },
    })
      .png()
      .toBuffer();
    const converter = new FixtureHeicConverter(localPng);
    const adapter = new SharpLocalPhotoImageAdapter(converter);

    await expect(
      sharp(invalidHeic, { failOn: "error" }).metadata(),
    ).rejects.toThrow();
    await expect(
      adapter.inspect({
        bytes: invalidHeic,
        detectedType: {
          format: "heic",
          mime: "image/heic",
          extension: "heic",
        },
      }),
    ).resolves.toEqual({ widthPx: 23, heightPx: 17 });
    expect(converter.calls).toBe(1);
    expect(converter.received).toEqual(invalidHeic);
    expect([...converter.lastReturned].every((byte) => byte === 0)).toBe(true);
    expect(invalidHeic.some((byte) => byte !== 0)).toBe(true);
  });

  it("normalizes sips launch failures and removes its private temporary files", async () => {
    const directory = await temporaryDirectory("hekayati-sips-failure-");
    cleanups.push(directory.cleanup);
    const converter = new SipsHeicConverter(
      "/missing/hekayati-sips-fixture",
      directory.path,
    );
    const rejection = await converter
      .convertToPng(Buffer.from("synthetic-local-only"), 10_000)
      .catch((error: unknown) => error);

    expect(rejection).toMatchObject({
      code: "PHOTO_DECODE_FAILED",
      message: "PHOTO_DECODE_FAILED",
    });
    expect(String(rejection)).not.toContain(directory.path);
    expect(await readdir(directory.path)).toEqual([]);
  });

  it("applies orientation and strips EXIF/XMP from every face derivative", async () => {
    const source = await syntheticJpegWithMetadata();
    const sourceMetadata = await sharp(source).metadata();
    expect(sourceMetadata.orientation).toBe(6);
    expect(sourceMetadata.xmp).toBeDefined();

    const prepared = await processor().prepare({
      source: oneChunk(source),
      limits: { maxBytes: 2_000_000, maxPixels: 1_000_000 },
      kind: "face",
      subjectSelection: {
        rectangle: { x: 0.25, y: 0.2, width: 0.5, height: 0.5 },
        confirmedByOperator: true,
      },
      observations: { peopleCount: 1 },
      referenceCountAfterCommit: 1,
    });
    const value = prepared.value;

    expect(value.original.bytes).toEqual(source);
    expect(value.workingDimensions).toEqual({ widthPx: 48, heightPx: 80 });
    expect(value.subjectCrop).toMatchObject({ widthPx: 24, heightPx: 40 });
    expect(value.providerDimensions).toEqual({ widthPx: 24, heightPx: 40 });
    expect(value.quality.metrics.subjectBoxAreaRatio).toBe(0.25);
    expect(value.quality.warnings.map(({ code }) => code)).toContain(
      "PHOTO_LIMITED_REFERENCES",
    );

    for (const derivative of [
      value.working,
      value.thumbnail,
      value.subjectCrop!,
    ]) {
      const metadata = await sharp(derivative.bytes).metadata();
      expect(metadata.orientation).toBeUndefined();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.iptc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.tifftagPhotoshop).toBeUndefined();
    }
    prepared.cleanup();
  });

  it("accepts a decoded PNG and records explainable blur and shadow metrics", async () => {
    const source = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const prepared = await processor().prepare({
      source: oneChunk(source),
      limits: { maxBytes: 100_000, maxPixels: 10_000 },
      kind: "face",
      subjectSelection: {
        rectangle: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        confirmedByOperator: true,
      },
    });

    expect(prepared.value.original).toMatchObject({
      format: "png",
      mime: "image/png",
      extension: "png",
    });
    expect(prepared.value.working.mime).toBe("image/jpeg");
    expect(prepared.value.quality.metrics).toMatchObject({
      widthPx: 64,
      heightPx: 64,
      subjectBoxAreaRatio: 0.04,
    });
    expect(prepared.value.quality.warnings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "PHOTO_BLURRY",
        "PHOTO_FACE_TOO_SMALL",
        "PHOTO_EXTREME_SHADOWS",
      ]),
    );
    prepared.cleanup();
  });

  it("rejects other decodable image formats instead of misclassifying their HEIF brand", async () => {
    const avif = await sharp({
      create: {
        width: 24,
        height: 24,
        channels: 3,
        background: "#f5a623",
      },
    })
      .avif()
      .toBuffer();

    await expect(
      processor().stage({
        source: oneChunk(avif),
        limits: { maxBytes: 100_000, maxPixels: 10_000 },
        kind: "other",
      }),
    ).rejects.toMatchObject({ code: "PHOTO_UNSUPPORTED_TYPE" });
  });

  it("rejects recognized but corrupt input with no decoder detail", async () => {
    const corrupt = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
    ]);
    const rejection = await processor()
      .prepare({
        source: oneChunk(corrupt),
        limits: { maxBytes: 100, maxPixels: 10_000 },
        kind: "other",
      })
      .catch((error: unknown) => error);

    expect(rejection).toMatchObject({
      code: "PHOTO_DECODE_FAILED",
      message: "PHOTO_DECODE_FAILED",
    });
    expect(String(rejection)).not.toContain("jpegload");
  });

  const heicIt = process.platform === "darwin" ? it : it.skip;
  heicIt("converts a synthetic HEIC locally through sips", async () => {
    const directory = await temporaryDirectory("hekayati-photo-heic-");
    cleanups.push(directory.cleanup);
    const pngPath = join(directory.path, "synthetic.png");
    const heicPath = join(directory.path, "synthetic.heic");
    await writeFile(
      pngPath,
      await sharp({
        create: {
          width: 40,
          height: 30,
          channels: 3,
          background: "#f5a623",
        },
      })
        .png()
        .toBuffer(),
      { mode: 0o600 },
    );
    await execFileAsync("/usr/bin/sips", [
      "-s",
      "format",
      "heic",
      pngPath,
      "--out",
      heicPath,
    ]);
    const source = await readFile(heicPath);

    await expect(
      processor().stage({
        source: oneChunk(source),
        limits: { maxBytes: 100_000, maxPixels: 1_199 },
        kind: "other",
      }),
    ).rejects.toMatchObject({ code: "PHOTO_PIXEL_LIMIT_EXCEEDED" });

    const prepared = await processor().prepare({
      source: oneChunk(source),
      limits: { maxBytes: 100_000, maxPixels: 10_000 },
      kind: "other",
    });

    expect(prepared.value.original).toMatchObject({
      format: "heic",
      mime: "image/heic",
      extension: "heic",
    });
    expect(prepared.value.working).toMatchObject({
      mime: "image/jpeg",
      widthPx: 40,
      heightPx: 30,
      metadataStripped: true,
    });
    expect(prepared.value.providerDerivative).toBe("working");
    prepared.cleanup();
  });
});

function processor() {
  return new PhotoIntakeProcessor(new SharpLocalPhotoImageAdapter());
}

async function syntheticJpegWithMetadata(): Promise<Buffer> {
  return sharp({
    create: {
      width: 80,
      height: 48,
      channels: 3,
      background: "#5d8c3e",
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withXmp(
      '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>',
    )
    .toBuffer();
}

async function* oneChunk(bytes: Buffer) {
  yield bytes;
}

class FixtureHeicConverter implements HeicConverter {
  calls = 0;
  received = Buffer.alloc(0);
  lastReturned = Buffer.alloc(0);

  constructor(private readonly png: Buffer) {}

  convertToPng(bytes: Buffer): Promise<Buffer> {
    this.calls += 1;
    this.received = Buffer.from(bytes);
    this.lastReturned = Buffer.from(this.png);
    return Promise.resolve(this.lastReturned);
  }
}
