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
