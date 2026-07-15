import type { NormalizedRegion } from "./measure.js";

export const BUBBLE_POLICY_VERSION = "hekayati.bubbles.v1";

export interface DialogueBubbleInput {
  speakerCharacterId: string;
  speakerLabel: string;
  text: string;
  positionHints: readonly string[];
}

export interface ResolvedDialogueBubble {
  speakerCharacterId: string;
  speakerLabel: string;
  text: string;
  region: NormalizedRegion;
  pointerAnchor: { x: number; y: number } | null;
}

const positionMap: Readonly<Record<string, { x: number; y: number }>> = {
  right: { x: 0.78, y: 0.5 },
  "scene right": { x: 0.78, y: 0.5 },
  يمين: { x: 0.78, y: 0.5 },
  "يمين المشهد": { x: 0.78, y: 0.5 },
  left: { x: 0.22, y: 0.5 },
  "scene left": { x: 0.22, y: 0.5 },
  يسار: { x: 0.22, y: 0.5 },
  "يسار المشهد": { x: 0.22, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  centre: { x: 0.5, y: 0.5 },
  وسط: { x: 0.5, y: 0.5 },
  "وسط المشهد": { x: 0.5, y: 0.5 },
  top: { x: 0.5, y: 0.22 },
  أعلى: { x: 0.5, y: 0.22 },
  bottom: { x: 0.5, y: 0.78 },
  أسفل: { x: 0.5, y: 0.78 },
};

export function resolveSpeakerAnchor(
  positionHints: readonly string[],
): { x: number; y: number } | null {
  const anchors = positionHints
    .map((hint) => positionMap[normalizeHint(hint)])
    .filter((value): value is { x: number; y: number } => Boolean(value));
  const unique = new Map(
    anchors.map((anchor) => [`${anchor.x}:${anchor.y}`, anchor]),
  );
  return unique.size === 1 ? ([...unique.values()][0] ?? null) : null;
}

export function resolveDialogueBubbles(
  dialogue: readonly DialogueBubbleInput[],
): {
  bubbles: ResolvedDialogueBubble[];
  warnings: string[];
  policyVersion: typeof BUBBLE_POLICY_VERSION;
} {
  const warnings: string[] = [];
  const occupied: NormalizedRegion[] = [];
  const bubbles = dialogue.map((item, index) => {
    const preferred = bubbleRegion(index);
    const region = shiftPastCollision(preferred, occupied);
    occupied.push(region);
    let pointerAnchor = resolveSpeakerAnchor(item.positionHints);
    if (pointerAnchor && lineCrossesBubble(pointerAnchor, region))
      pointerAnchor = null;
    if (!pointerAnchor) warnings.push("SPEAKER_ANCHOR_INDETERMINATE");
    if (region.y + region.height > 0.94) warnings.push("DIALOGUE_OVERFLOW");
    return {
      speakerCharacterId: item.speakerCharacterId,
      speakerLabel: item.speakerLabel,
      text: item.text,
      region,
      pointerAnchor,
    };
  });
  return {
    bubbles,
    warnings: [...new Set(warnings)],
    policyVersion: BUBBLE_POLICY_VERSION,
  };
}

function normalizeHint(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US");
}

function bubbleRegion(index: number): NormalizedRegion {
  return {
    x: index % 2 === 0 ? 0.1 : 0.52,
    y: 0.1 + Math.floor(index / 2) * 0.19,
    width: 0.38,
    height: 0.15,
  };
}

function shiftPastCollision(
  initial: NormalizedRegion,
  occupied: readonly NormalizedRegion[],
): NormalizedRegion {
  let region = initial;
  while (occupied.some((other) => intersects(region, other)))
    region = { ...region, y: region.y + 0.17 };
  return region;
}

function intersects(a: NormalizedRegion, b: NormalizedRegion): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function lineCrossesBubble(
  anchor: { x: number; y: number },
  bubble: NormalizedRegion,
): boolean {
  return (
    anchor.x >= bubble.x &&
    anchor.x <= bubble.x + bubble.width &&
    anchor.y >= bubble.y &&
    anchor.y <= bubble.y + bubble.height
  );
}
