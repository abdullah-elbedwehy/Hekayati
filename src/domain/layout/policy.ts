import { hashCanonical } from "./hashes.js";
import {
  resolveDialogueBubbles,
  type DialogueBubbleInput,
} from "../../layout/bubbles.js";
import {
  fitLayoutText,
  type LayoutAgeBand,
  type NormalizedRegion,
} from "../../layout/measure.js";

export const LAYOUT_POLICY_VERSION = "hekayati.layout.v1";
export const LAYOUT_RENDERER_VERSION = "hekayati.chromium.v1";
export const A4_COMPOSITION_PROFILE_ID = "00000000000000000000000000";

export type { NormalizedRegion } from "../../layout/measure.js";

const profileContent = {
  id: A4_COMPOSITION_PROFILE_ID,
  version: "a4-portrait-v1",
  trimWidthMm: 210,
  trimHeightMm: 297,
  dimensionToleranceMm: 0.5,
  safeContentRegion: { x: 0.07, y: 0.05, width: 0.86, height: 0.9 },
  placementRegions: {
    top: { x: 0.08, y: 0.06, width: 0.84, height: 0.25 },
    bottom: { x: 0.08, y: 0.69, width: 0.84, height: 0.25 },
    right: { x: 0.62, y: 0.1, width: 0.3, height: 0.8 },
    left: { x: 0.08, y: 0.1, width: 0.3, height: 0.8 },
  },
  typographyScale: { age_3_5: 24, age_6_8: 20, age_9_12: 18 },
} as const;

export const A4_COMPOSITION_PROFILE = Object.freeze({
  ...profileContent,
  hash: hashCanonical(profileContent),
});

export type Placement = "auto" | "top" | "bottom" | "right" | "left";
type ResolvedPlacement = Exclude<Placement, "auto">;
export interface RegionMeasurement {
  quietness: number;
  contrast: number;
  safeArea?: boolean;
}

export interface DialoguePolicyInput {
  speakerCharacterId: string;
  speakerLabel: string;
  text: string;
  position: { x: number; y: number } | null;
  positionHints?: readonly string[];
}

export interface LayoutPolicyInput {
  requestedPlacement: Placement;
  ageBand: LayoutAgeBand;
  text: string;
  measurements: Record<ResolvedPlacement, RegionMeasurement>;
  dialogue: DialoguePolicyInput[];
}

export interface LayoutPolicyResult {
  requestedPlacement: Placement;
  resolvedPlacement: ResolvedPlacement;
  resolvedRegion: NormalizedRegion;
  readabilityAid: "none" | "gradient" | "panel";
  fontSizePt: number;
  overflow: boolean;
  warnings: string[];
  acceptance: "ready" | "needs_operator";
  bubbles: Array<{
    speakerCharacterId: string;
    speakerLabel: string;
    text: string;
    region: NormalizedRegion;
    pointerAnchor: { x: number; y: number } | null;
  }>;
  measurementHash: string;
  layoutPolicyVersion: typeof LAYOUT_POLICY_VERSION;
  rendererVersion: typeof LAYOUT_RENDERER_VERSION;
}

const placementOrder: readonly ResolvedPlacement[] = [
  "top",
  "bottom",
  "right",
  "left",
];

export function resolveLayoutPolicy(
  input: LayoutPolicyInput,
): LayoutPolicyResult {
  const resolvedPlacement = selectPlacement(input);
  const measurement = input.measurements[resolvedPlacement];
  const resolvedRegion = A4_COMPOSITION_PROFILE.placementRegions[
    resolvedPlacement
  ] as NormalizedRegion;
  const readabilityAid = selectAid(measurement);
  const type = fitLayoutText({
    text: input.text,
    ageBand: input.ageBand,
    region: resolvedRegion,
  });
  const bubbleResult = resolveBubbles(input.dialogue);
  const unsafeRegion = measurement.safeArea === false;
  const warnings = [
    ...(readabilityAid === "none"
      ? []
      : [`READABILITY_${readabilityAid.toUpperCase()}_REQUIRED`]),
    ...(unsafeRegion ? ["NO_SAFE_TEXT_REGION"] : []),
    ...type.warnings,
    ...bubbleResult.warnings,
  ];
  return {
    requestedPlacement: input.requestedPlacement,
    resolvedPlacement,
    resolvedRegion,
    readabilityAid,
    fontSizePt: type.fontSizePt,
    overflow: type.overflow,
    warnings,
    acceptance:
      type.overflow ||
      unsafeRegion ||
      type.warnings.includes("UNSAFE_BIDI_CONTROL")
        ? "needs_operator"
        : "ready",
    bubbles: bubbleResult.bubbles,
    measurementHash: hashCanonical({
      measurements: input.measurements,
      textLength: [...input.text].length,
      ageBand: input.ageBand,
    }),
    layoutPolicyVersion: LAYOUT_POLICY_VERSION,
    rendererVersion: LAYOUT_RENDERER_VERSION,
  };
}

function selectPlacement(input: LayoutPolicyInput): ResolvedPlacement {
  if (input.requestedPlacement !== "auto") return input.requestedPlacement;
  const candidates = placementOrder.filter(
    (placement) => input.measurements[placement].safeArea !== false,
  );
  let selected = candidates[0] ?? placementOrder[0];
  let selectedScore = score(input.measurements[selected]);
  for (const placement of candidates.slice(1)) {
    const candidate = score(input.measurements[placement]);
    if (candidate > selectedScore) {
      selected = placement;
      selectedScore = candidate;
    }
  }
  return selected;
}

function score(measurement: RegionMeasurement): number {
  return measurement.quietness * 0.6 + Math.min(measurement.contrast, 12) / 30;
}

function selectAid(
  measurement: RegionMeasurement,
): LayoutPolicyResult["readabilityAid"] {
  if (measurement.quietness >= 0.55 && measurement.contrast >= 4.5)
    return "none";
  if (measurement.quietness >= 0.3 || measurement.contrast >= 3)
    return "gradient";
  return "panel";
}

function resolveBubbles(dialogue: DialoguePolicyInput[]): {
  bubbles: LayoutPolicyResult["bubbles"];
  warnings: string[];
} {
  const solved = resolveDialogueBubbles(
    dialogue.map((item): DialogueBubbleInput => ({
      speakerCharacterId: item.speakerCharacterId,
      speakerLabel: item.speakerLabel,
      text: item.text,
      positionHints: item.positionHints ?? [],
    })),
  );
  const bubbles = solved.bubbles.map((bubble, index) => ({
    ...bubble,
    pointerAnchor:
      safeAnchor(dialogue[index]?.position) ?? bubble.pointerAnchor,
  }));
  const warnings = [...solved.warnings];
  for (let index = 0; index < bubbles.length; index += 1) {
    if (bubbles[index]?.pointerAnchor) {
      const remainingIndeterminate = bubbles.some(
        (bubble, bubbleIndex) => bubbleIndex !== index && !bubble.pointerAnchor,
      );
      if (!remainingIndeterminate) {
        const warningIndex = warnings.indexOf("SPEAKER_ANCHOR_INDETERMINATE");
        if (warningIndex >= 0) warnings.splice(warningIndex, 1);
      }
    }
  }
  return { bubbles, warnings: [...new Set(warnings)] };
}

function safeAnchor(
  position: DialoguePolicyInput["position"],
): { x: number; y: number } | null {
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    position.x < 0 ||
    position.x > 1 ||
    position.y < 0 ||
    position.y > 1
  )
    return null;
  return position;
}
