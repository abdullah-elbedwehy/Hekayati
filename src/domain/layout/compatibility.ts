import type { NormalizedRegion } from "../../layout/measure.js";

export interface CustomerCompositionGeometry {
  trimWidthMm: number;
  trimHeightMm: number;
  dimensionToleranceMm: number;
  safeContentRegion: NormalizedRegion;
}

export interface PrinterCompatibilityGeometry {
  orientation: "portrait" | "landscape";
  trimWidthMm: number;
  trimHeightMm: number;
  safeContentRegion: NormalizedRegion;
  printerOnly?: unknown;
}

export type CompositionCompatibilityResult =
  | { compatible: true }
  | {
      compatible: false;
      code: "COMPOSITION_PROFILE_MISMATCH";
      failedPredicates: Array<
        "orientation" | "width" | "height" | "safe_region"
      >;
      expected: { widthMm: number; heightMm: number; toleranceMm: number };
      actual: { widthMm: number; heightMm: number; orientation: string };
    };

export function checkCompositionCompatibility(
  composition: CustomerCompositionGeometry,
  printer: PrinterCompatibilityGeometry,
): CompositionCompatibilityResult {
  const failedPredicates: Array<
    "orientation" | "width" | "height" | "safe_region"
  > = [];
  if (printer.orientation !== "portrait") failedPredicates.push("orientation");
  if (
    Math.abs(printer.trimWidthMm - composition.trimWidthMm) >
    composition.dimensionToleranceMm
  )
    failedPredicates.push("width");
  if (
    Math.abs(printer.trimHeightMm - composition.trimHeightMm) >
    composition.dimensionToleranceMm
  )
    failedPredicates.push("height");
  if (!contains(printer.safeContentRegion, composition.safeContentRegion))
    failedPredicates.push("safe_region");
  if (failedPredicates.length === 0) return { compatible: true };
  return {
    compatible: false,
    code: "COMPOSITION_PROFILE_MISMATCH",
    failedPredicates,
    expected: {
      widthMm: composition.trimWidthMm,
      heightMm: composition.trimHeightMm,
      toleranceMm: composition.dimensionToleranceMm,
    },
    actual: {
      widthMm: printer.trimWidthMm,
      heightMm: printer.trimHeightMm,
      orientation: printer.orientation,
    },
  };
}

function contains(outer: NormalizedRegion, inner: NormalizedRegion): boolean {
  const epsilon = 1e-9;
  return (
    outer.x <= inner.x + epsilon &&
    outer.y <= inner.y + epsilon &&
    outer.x + outer.width + epsilon >= inner.x + inner.width &&
    outer.y + outer.height + epsilon >= inner.y + inner.height
  );
}
