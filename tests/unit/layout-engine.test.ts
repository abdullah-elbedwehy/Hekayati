import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  resolveDialogueBubbles,
  resolveSpeakerAnchor,
} from "../../src/layout/bubbles.js";
import { analyzeImageRegions } from "../../src/layout/image-analysis.js";
import {
  fitLayoutText,
  normalizeLayoutText,
} from "../../src/layout/measure.js";

describe("layout text measurement", () => {
  it("normalizes canonically and reports unsafe bidi controls", () => {
    const normalized = normalizeLayoutText("ا\u0654هلاً\u202E<script>");

    expect(normalized.text).toBe("أهلاً�<script>");
    expect(normalized.warnings).toEqual(["UNSAFE_BIDI_CONTROL"]);
  });

  it("keeps age floors and exposes long-token and capacity overflow", () => {
    const short = fitLayoutText({
      text: "مغامرة لطيفة",
      ageBand: "age_3_5",
      region: { x: 0.08, y: 0.06, width: 0.84, height: 0.25 },
    });
    expect(short).toMatchObject({ fontSizePt: 24, overflow: false });

    const longToken = fitLayoutText({
      text: "س".repeat(180),
      ageBand: "age_6_8",
      region: { x: 0.08, y: 0.06, width: 0.84, height: 0.25 },
    });
    expect(longToken.fontSizePt).toBe(12);
    expect(longToken.overflow).toBe(true);
    expect(longToken.warnings).toContain("UNBREAKABLE_TOKEN_OVERFLOW");
  });
});

describe("dialogue bubble solver", () => {
  it("uses only one recognized on-canvas source hint", () => {
    expect(resolveSpeakerAnchor(["يمين المشهد"])).toEqual({ x: 0.78, y: 0.5 });
    expect(resolveSpeakerAnchor(["يمين", "يسار"])).toBeNull();
    expect(resolveSpeakerAnchor(["خارج الصورة"])).toBeNull();
  });

  it("preserves dialogue order and falls back instead of guessing", () => {
    const result = resolveDialogueBubbles([
      {
        speakerCharacterId: "01J00000000000000000000001",
        speakerLabel: "ليلى",
        text: "هيا بنا",
        positionHints: ["يمين"],
      },
      {
        speakerCharacterId: "01J00000000000000000000002",
        speakerLabel: "عمر",
        text: "أنا جاهز",
        positionHints: ["يمين", "يسار"],
      },
    ]);

    expect(result.bubbles.map((item) => item.speakerLabel)).toEqual([
      "ليلى",
      "عمر",
    ]);
    expect(result.bubbles[0]?.pointerAnchor).toEqual({ x: 0.78, y: 0.5 });
    expect(result.bubbles[1]?.pointerAnchor).toBeNull();
    expect(result.warnings).toContain("SPEAKER_ANCHOR_INDETERMINATE");
  });

  it("drops a pointer crossing its bubble and reports bounded dialogue overflow once", () => {
    const dialogue = Array.from({ length: 9 }, (_, index) => ({
      speakerCharacterId: `01J${String(index + 1).padStart(23, "0")}`,
      speakerLabel: `متحدث ${index + 1}`,
      text: `جملة ${index + 1}`,
      positionHints: index === 4 ? ["يسار"] : ["يمين"],
    }));
    const result = resolveDialogueBubbles(dialogue);

    expect(result.bubbles[4]?.pointerAnchor).toBeNull();
    expect(
      result.bubbles[8].region.y + result.bubbles[8].region.height,
    ).toBeGreaterThan(0.94);
    expect(result.warnings).toEqual([
      "SPEAKER_ANCHOR_INDETERMINATE",
      "DIALOGUE_OVERFLOW",
    ]);
  });
});

describe("image region analysis", () => {
  it("prefers a flat high-contrast region over a noisy one", async () => {
    const width = 120;
    const height = 80;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = x < width / 2 ? 245 : (x + y) % 2 === 0 ? 0 : 255;
        const offset = (y * width + x) * 3;
        pixels[offset] = value;
        pixels[offset + 1] = value;
        pixels[offset + 2] = value;
      }
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();

    const facts = await analyzeImageRegions(png, {
      left: { x: 0, y: 0, width: 0.5, height: 1 },
      right: { x: 0.5, y: 0, width: 0.5, height: 1 },
    });

    expect(facts.left.quietness).toBeGreaterThan(facts.right.quietness);
    expect(facts.left.contrast).toBeGreaterThanOrEqual(4.5);
    expect(facts.analysisVersion).toBe("hekayati.image-analysis.v1");
  });

  it.each([
    { x: Number.NaN, y: 0, width: 1, height: 1 },
    { x: -0.1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0.2, y: 0, width: 0.9, height: 1 },
    { x: 0, y: 0.3, width: 1, height: 0.8 },
  ])("rejects invalid normalized analysis region %#", async (region) => {
    const png = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: "white",
      },
    })
      .png()
      .toBuffer();
    await expect(analyzeImageRegions(png, { invalid: region })).rejects.toThrow(
      "LAYOUT_REGION_INVALID",
    );
  });
});
