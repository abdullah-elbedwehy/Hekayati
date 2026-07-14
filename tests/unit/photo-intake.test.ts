import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PhotoIntakeError,
  PhotoIntakeProcessor,
  evaluatePhotoQuality,
  readBoundedPhoto,
  sniffSupportedPhoto,
  toPixelCrop,
  validateSubjectSelection,
  withPreparedPhoto,
  type ImageInspection,
  type LocalPhotoImageAdapter,
  type PhotoBaseDerivativeSet,
  type SafePhotoDerivative,
} from "../../src/assets/photo-intake/index.js";

const pngHeader = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("bounded photo input", () => {
  it("stops as soon as streamed bytes exceed the configured limit", async () => {
    let yielded = 0;
    const source = async function* () {
      for (const chunk of [
        Buffer.alloc(4, 1),
        Buffer.alloc(5, 2),
        Buffer.alloc(1),
      ]) {
        yielded += 1;
        yield chunk;
      }
    };

    await expect(readBoundedPhoto(source(), 8)).rejects.toMatchObject({
      code: "PHOTO_FILE_TOO_LARGE",
      message: "PHOTO_FILE_TOO_LARGE",
    });
    expect(yielded).toBe(2);
  });

  it("copies accepted chunks and normalizes stream failures to a safe error", async () => {
    const callerOwned = Buffer.from([1, 2, 3]);
    const accepted = await readBoundedPhoto(
      (async function* () {
        yield callerOwned;
      })(),
      3,
    );
    accepted.fill(0);
    expect(callerOwned).toEqual(Buffer.from([1, 2, 3]));

    const unsafe = async function* () {
      yield Buffer.from([1]);
      throw new Error("decoder failed at /private/customer/photo.jpg");
    };
    const rejection = await readBoundedPhoto(unsafe(), 20).catch(
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      code: "PHOTO_DECODE_FAILED",
      message: "PHOTO_DECODE_FAILED",
    });
    expect(String(rejection)).not.toContain("/private/customer");
  });

  it("detects only JPEG, PNG, and HEIC-family content without trusting a name", async () => {
    const jpeg = await sniffSupportedPhoto(
      Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
    );
    const png = await sniffSupportedPhoto(pngHeader);
    const heic = await sniffSupportedPhoto(
      Buffer.from("000000186674797068656963000000006d69663168656963", "hex"),
    );

    expect(jpeg).toEqual({
      format: "jpeg",
      mime: "image/jpeg",
      extension: "jpg",
    });
    expect(png).toEqual({ format: "png", mime: "image/png", extension: "png" });
    expect(heic).toEqual({
      format: "heic",
      mime: "image/heic",
      extension: "heic",
    });
    await expect(
      sniffSupportedPhoto(Buffer.from("GIF89a synthetic")),
    ).rejects.toMatchObject({ code: "PHOTO_UNSUPPORTED_TYPE" });
  });
});

describe("subject selection", () => {
  it("requires an operator-confirmed normalized rectangle for every face", () => {
    expect(() => validateSubjectSelection("face", undefined)).toThrowError(
      expect.objectContaining({ code: "PHOTO_SUBJECT_SELECTION_REQUIRED" }),
    );
    expect(() =>
      validateSubjectSelection("face", {
        rectangle: { x: 0.8, y: 0, width: 0.3, height: 0.5 },
        confirmedByOperator: true,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PHOTO_SUBJECT_SELECTION_REQUIRED" }),
    );
    expect(() =>
      toPixelCrop(
        { x: 0.5, y: 0.5, width: Number.MIN_VALUE, height: Number.MIN_VALUE },
        100,
        100,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "PHOTO_SUBJECT_SELECTION_REQUIRED" }),
    );
    expect(() =>
      validateSubjectSelection("face", {
        rectangle: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        confirmedByOperator: false,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PHOTO_SUBJECT_SELECTION_REQUIRED" }),
    );
  });

  it("maps a valid keyboard-compatible rectangle to bounded oriented pixels", () => {
    const selection = validateSubjectSelection("face", {
      rectangle: { x: 0.1, y: 0.25, width: 0.3, height: 0.5 },
      confirmedByOperator: true,
    });

    expect(selection).toEqual({ x: 0.1, y: 0.25, width: 0.3, height: 0.5 });
    expect(toPixelCrop(selection!, 101, 80)).toEqual({
      left: 10,
      top: 20,
      width: 31,
      height: 40,
    });
    expect(validateSubjectSelection("other", undefined)).toBeUndefined();
    expect(
      validateSubjectSelection("other", {
        rectangle: { x: 0.1, y: 0.1, width: 0.5, height: 0.6 },
        confirmedByOperator: true,
      }),
    ).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.6 });
  });
});

describe("versioned non-biometric photo quality policy", () => {
  it("records local thresholds and explicit operator observations without inference", () => {
    const quality = evaluatePhotoQuality({
      metrics: {
        widthPx: 1200,
        heightPx: 900,
        blurScore: 72,
        exposureScore: 0.2,
        shadowFraction: 0.42,
        subjectBoxAreaRatio: 0.04,
      },
      observations: {
        peopleCount: 2,
        obstruction: "operator-recorded obstruction",
        filterSuspected: true,
        apparentAgeBand: "operator-band-a",
        hair: "operator-hair-a",
        clothing: "operator-clothing-a",
      },
      existingObservations: [
        {
          apparentAgeBand: "operator-band-b",
          hair: "operator-hair-b",
          clothing: "operator-clothing-b",
        },
      ],
      referenceCountAfterCommit: 1,
    });

    expect(quality.policyVersion).toBe("PhotoQualityPolicy/v1");
    expect(quality.warnings.map(({ code }) => code)).toEqual([
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
    expect(
      quality.warnings.find(({ code }) => code === "PHOTO_BLURRY"),
    ).toMatchObject({
      source: "local_check",
      metric: "blurScore",
      threshold: 80,
      value: 72,
    });
    expect(
      quality.warnings.find(({ code }) => code === "PHOTO_AGE_CONFLICT"),
    ).toMatchObject({ source: "operator", observation: "apparentAgeBand" });
  });

  it("does not invent semantic warnings when the operator records none", () => {
    const quality = evaluatePhotoQuality({
      metrics: {
        widthPx: 800,
        heightPx: 800,
        blurScore: 100,
        exposureScore: 0.5,
        shadowFraction: 0.1,
      },
    });

    expect(quality.warnings).toEqual([]);
    expect(quality.observations).toEqual({});
  });
});

describe("atomic prepared photo result", () => {
  it("returns canonical original/derivative metadata and zeroizes all owned bytes", async () => {
    const adapter = new FakeImageAdapter();
    const input = Buffer.concat([pngHeader, Buffer.from("synthetic")]);
    const processor = new PhotoIntakeProcessor(adapter);
    const prepared = await processor.prepare({
      source: oneChunk(input),
      limits: { maxBytes: 1024, maxPixels: 10_000 },
      kind: "face",
      subjectSelection: {
        rectangle: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        confirmedByOperator: true,
      },
      observations: { peopleCount: 1 },
    });
    const value = prepared.value;

    expect(value.original).toMatchObject({
      format: "png",
      mime: "image/png",
      extension: "png",
      bytes: input,
      sha256: createHash("sha256").update(input).digest("hex"),
    });
    expect(value.working).toMatchObject({
      mime: "image/jpeg",
      extension: "jpg",
      widthPx: 100,
      heightPx: 80,
      metadataStripped: true,
    });
    expect(value.providerDerivative).toBe("subject_crop");
    expect(value.providerDimensions).toEqual({ widthPx: 50, heightPx: 40 });
    expect(value.subjectCrop).toBeDefined();
    expect(adapter.inspectCalls).toBe(1);
    expect(adapter.baseDeriveCalls).toBe(1);
    expect(adapter.cropDeriveCalls).toBe(1);

    const owned = [
      value.original.bytes,
      value.working.bytes,
      value.thumbnail.bytes,
      value.subjectCrop!.bytes,
    ];
    prepared.cleanup();
    prepared.cleanup();
    for (const bytes of owned)
      expect([...bytes].every((byte) => byte === 0)).toBe(true);
    expect(() => prepared.value).toThrow("PREPARED_PHOTO_RELEASED");
    expect(input).toEqual(Buffer.concat([pngHeader, Buffer.from("synthetic")]));
  });

  it("enforces decoded pixels before any transform", async () => {
    const pixelAdapter = new FakeImageAdapter({ widthPx: 101, heightPx: 100 });
    const processor = new PhotoIntakeProcessor(pixelAdapter);
    await expect(
      processor.prepare({
        source: oneChunk(pngHeader),
        limits: { maxBytes: 100, maxPixels: 10_000 },
        kind: "other",
      }),
    ).rejects.toMatchObject({ code: "PHOTO_PIXEL_LIMIT_EXCEEDED" });
    expect(pixelAdapter.baseDeriveCalls).toBe(0);
  });

  it("stages a safe face preview before selection and enforces the box only at finalize", async () => {
    const adapter = new FakeImageAdapter();
    const processor = new PhotoIntakeProcessor(adapter);
    const staged = await processor.stage({
      source: oneChunk(pngHeader),
      limits: { maxBytes: 100, maxPixels: 10_000 },
      kind: "face",
    });

    expect(staged.value).toMatchObject({
      kind: "face",
      workingDimensions: { widthPx: 100, heightPx: 80 },
      preliminaryQuality: { policyVersion: "PhotoQualityPolicy/v1" },
    });
    expect(staged.value.thumbnail.bytes).toEqual(Buffer.from("thumbnail"));
    expect(adapter.baseDeriveCalls).toBe(1);
    expect(adapter.cropDeriveCalls).toBe(0);

    await expect(processor.finalize(staged, {})).rejects.toMatchObject({
      code: "PHOTO_SUBJECT_SELECTION_REQUIRED",
    });
    expect(staged.value.kind).toBe("face");
    expect(adapter.cropDeriveCalls).toBe(0);

    const prepared = await processor.finalize(staged, {
      subjectSelection: {
        rectangle: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        confirmedByOperator: true,
      },
      observations: { peopleCount: 2 },
    });
    expect(prepared.value.providerDerivative).toBe("subject_crop");
    expect(adapter.cropDeriveCalls).toBe(1);
    expect(() => staged.value).toThrow("STAGED_PHOTO_TRANSFERRED");
    prepared.cleanup();
  });

  it("maps arbitrary adapter failures to one safe stable decode error", async () => {
    const adapter = new FakeImageAdapter();
    adapter.failure = new Error(
      "sharp exposed /Users/name/customer-child.heic",
    );
    const rejection = await new PhotoIntakeProcessor(adapter)
      .prepare({
        source: oneChunk(pngHeader),
        limits: { maxBytes: 100, maxPixels: 10_000 },
        kind: "other",
      })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(PhotoIntakeError);
    expect(rejection).toMatchObject({
      code: "PHOTO_DECODE_FAILED",
      message: "PHOTO_DECODE_FAILED",
    });
    expect(String(rejection)).not.toContain("customer-child");
  });

  it("releases staged and prepared buffers through idempotent lifecycle helpers", async () => {
    const processor = new PhotoIntakeProcessor(new FakeImageAdapter());
    const staged = await processor.stage({
      source: oneChunk(pngHeader),
      limits: { maxBytes: 100, maxPixels: 10_000 },
      kind: "other",
    });
    const stagedBytes = staged.value.original.bytes;
    staged.cleanup();
    staged.cleanup();
    expect([...stagedBytes].every((byte) => byte === 0)).toBe(true);
    expect(() => staged.value).toThrow("STAGED_PHOTO_RELEASED");

    const prepared = await processor.prepare({
      source: oneChunk(pngHeader),
      limits: { maxBytes: 100, maxPixels: 10_000 },
      kind: "other",
    });
    const exact = prepared.value.original.bytes;
    await expect(
      withPreparedPhoto(prepared, async (value) => value.providerDerivative),
    ).resolves.toBe("working");
    expect([...exact].every((byte) => byte === 0)).toBe(true);
  });

  it("provides actionable Arabic copy without changing the stable error code", () => {
    expect(
      new PhotoIntakeError("PHOTO_SUBJECT_SELECTION_REQUIRED").toSafeResponse(),
    ).toEqual({
      code: "PHOTO_SUBJECT_SELECTION_REQUIRED",
      message: "حدّد الشخص المقصود داخل الصورة قبل المتابعة.",
    });
  });
});

class FakeImageAdapter implements LocalPhotoImageAdapter {
  inspectCalls = 0;
  baseDeriveCalls = 0;
  cropDeriveCalls = 0;
  failure?: Error;

  constructor(
    private readonly inspection: ImageInspection = {
      widthPx: 100,
      heightPx: 80,
    },
  ) {}

  inspect(): Promise<ImageInspection> {
    this.inspectCalls += 1;
    return Promise.resolve(this.inspection);
  }

  deriveBase(): Promise<PhotoBaseDerivativeSet> {
    this.baseDeriveCalls += 1;
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({
      working: derivative("working", 100, 80),
      thumbnail: derivative("thumbnail", 64, 51),
      metrics: {
        blurScore: 100,
        exposureScore: 0.5,
        shadowFraction: 0.1,
      },
    });
  }

  deriveSubjectCrop(): Promise<SafePhotoDerivative> {
    this.cropDeriveCalls += 1;
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(derivative("crop", 50, 40));
  }
}

function derivative(label: string, widthPx: number, heightPx: number) {
  return {
    bytes: Buffer.from(label),
    mime: "image/jpeg" as const,
    extension: "jpg" as const,
    widthPx,
    heightPx,
    metadataStripped: true as const,
  };
}

async function* oneChunk(bytes: Buffer) {
  yield bytes;
}
