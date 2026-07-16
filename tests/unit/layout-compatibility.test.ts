import { describe, expect, it } from "vitest";

import { checkCompositionCompatibility } from "../../src/domain/layout/compatibility.js";

const composition = {
  trimWidthMm: 210,
  trimHeightMm: 297,
  dimensionToleranceMm: 0.5,
  safeContentRegion: { x: 0.07, y: 0.05, width: 0.86, height: 0.9 },
};

describe("composition-to-printer compatibility", () => {
  it("accepts portrait dimensions within tolerance and safe containment", () => {
    expect(
      checkCompositionCompatibility(composition, {
        orientation: "portrait",
        trimWidthMm: 210.4,
        trimHeightMm: 296.6,
        safeContentRegion: { x: 0.06, y: 0.04, width: 0.88, height: 0.92 },
        printerOnly: { dpi: 600, bleedMm: 12, colorSpace: "CMYK" },
      }),
    ).toEqual({ compatible: true });
  });

  it.each([
    ["positive width", { trimWidthMm: 210.5 }],
    ["negative width", { trimWidthMm: 209.5 }],
    ["positive height", { trimHeightMm: 297.5 }],
    ["negative height", { trimHeightMm: 296.5 }],
  ])("accepts the exact %s tolerance boundary", (_name, override) => {
    expect(
      checkCompositionCompatibility(composition, {
        orientation: "portrait",
        trimWidthMm: 210,
        trimHeightMm: 297,
        safeContentRegion: { ...composition.safeContentRegion },
        ...override,
      }),
    ).toEqual({ compatible: true });
  });

  it("accepts exact equality at every safe-region boundary", () => {
    expect(
      checkCompositionCompatibility(composition, {
        orientation: "portrait",
        trimWidthMm: composition.trimWidthMm,
        trimHeightMm: composition.trimHeightMm,
        safeContentRegion: { ...composition.safeContentRegion },
      }),
    ).toEqual({ compatible: true });
  });

  it.each([
    ["bleed", { bleedMm: 30 }],
    ["DPI", { dpi: 2_400 }],
    ["color", { colorSpace: "CMYK" }],
    ["ICC", { iccChecksum: "a".repeat(64) }],
    ["crop marks", { cropMarks: { enabled: true, offsetMm: 8 } }],
    ["spine", { spineWidthMm: 200 }],
    [
      "printer blanks",
      { requiredBlankPages: [{ position: "before_interior", count: 8 }] },
    ],
  ])(
    "ignores printer-only %s when composition geometry is unchanged",
    (_name, printerOnly) => {
      expect(
        checkCompositionCompatibility(composition, {
          orientation: "portrait",
          trimWidthMm: composition.trimWidthMm,
          trimHeightMm: composition.trimHeightMm,
          safeContentRegion: { ...composition.safeContentRegion },
          printerOnly,
        }),
      ).toEqual({ compatible: true });
    },
  );

  it.each([
    ["orientation", { orientation: "landscape" as const }],
    ["width", { trimWidthMm: 210.6 }],
    ["height", { trimHeightMm: 297.6 }],
    [
      "safe_region",
      { safeContentRegion: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } },
    ],
  ])("rejects a %s mismatch without a scale fallback", (_name, override) => {
    const result = checkCompositionCompatibility(composition, {
      orientation: "portrait",
      trimWidthMm: 210,
      trimHeightMm: 297,
      safeContentRegion: { x: 0.06, y: 0.04, width: 0.88, height: 0.92 },
      ...override,
    });

    expect(result).toMatchObject({
      compatible: false,
      code: "COMPOSITION_PROFILE_MISMATCH",
    });
  });
});
