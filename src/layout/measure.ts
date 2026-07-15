export type LayoutAgeBand = "age_3_5" | "age_6_8" | "age_9_12";

export interface NormalizedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const LAYOUT_MEASUREMENT_VERSION = "hekayati.text-measure.v1";

const unsafeBidiControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

const typography = {
  age_3_5: { start: 24, floor: 14 },
  age_6_8: { start: 20, floor: 12 },
  age_9_12: { start: 18, floor: 12 },
} as const;

export function normalizeLayoutText(value: string): {
  text: string;
  warnings: string[];
} {
  const normalized = value.normalize("NFC");
  const hasUnsafeControl = unsafeBidiControls.test(normalized);
  unsafeBidiControls.lastIndex = 0;
  return {
    text: normalized.replace(unsafeBidiControls, "�"),
    warnings: hasUnsafeControl ? ["UNSAFE_BIDI_CONTROL"] : [],
  };
}

export function fitLayoutText(input: {
  text: string;
  ageBand: LayoutAgeBand;
  region: NormalizedRegion;
}): {
  fontSizePt: number;
  overflow: boolean;
  estimatedLines: number;
  warnings: string[];
  measurementVersion: typeof LAYOUT_MEASUREMENT_VERSION;
} {
  const normalized = normalizeLayoutText(input.text);
  const settings = typography[input.ageBand];
  let fontSizePt = settings.start;
  let facts = estimate(normalized.text, input.region, fontSizePt);
  while (fontSizePt > settings.floor && facts.overflow) {
    fontSizePt -= 1;
    facts = estimate(normalized.text, input.region, fontSizePt);
  }
  const warnings = [...normalized.warnings];
  if (facts.longestTokenOverflow) warnings.push("UNBREAKABLE_TOKEN_OVERFLOW");
  if (facts.overflow) warnings.push("TEXT_OVERFLOW");
  return {
    fontSizePt,
    overflow: facts.overflow,
    estimatedLines: facts.lines,
    warnings: [...new Set(warnings)],
    measurementVersion: LAYOUT_MEASUREMENT_VERSION,
  };
}

function estimate(
  text: string,
  region: NormalizedRegion,
  fontSizePt: number,
): { overflow: boolean; longestTokenOverflow: boolean; lines: number } {
  const widthMm = region.width * 210;
  const heightMm = region.height * 297;
  const averageGlyphMm = fontSizePt * 0.352_778 * 0.57;
  const charsPerLine = Math.max(1, Math.floor(widthMm / averageGlyphMm));
  const lineHeightMm = fontSizePt * 0.352_778 * 1.45;
  const availableLines = Math.max(1, Math.floor(heightMm / lineHeightMm));
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  let lines = 1;
  let used = 0;
  let longestTokenOverflow = false;
  for (const token of tokens) {
    const length = [...token].length;
    if (length > charsPerLine) longestTokenOverflow = true;
    if (used === 0) used = length;
    else if (used + 1 + length <= charsPerLine) used += 1 + length;
    else {
      lines += Math.max(1, Math.ceil(length / charsPerLine));
      used = length % charsPerLine;
    }
  }
  return {
    overflow: lines > availableLines || longestTokenOverflow,
    longestTokenOverflow,
    lines,
  };
}
