import type {
  PrinterProfileProjection,
  PrintProfileDraft,
} from "../../print-types";

export function defaultDraft(): PrintProfileDraft {
  return {
    trim: { widthMm: 210, heightMm: 297, orientation: "portrait" },
    bleedMm: 3,
    safeContentRegion: { x: 0.07, y: 0.05, width: 0.86, height: 0.9 },
    dpiMin: 300,
    color: { mode: "rgb" },
    cropMarks: {
      enabled: false,
      offsetMm: 0,
      lengthMm: 0,
      strokePt: 0.25,
    },
    spine: { source: "missing", widthMm: null },
    coverTemplate: null,
    requiredBlankPages: [],
  };
}

export function draftFromProfile(
  profile: PrinterProfileProjection,
): PrintProfileDraft {
  const version = profile.version;
  return structuredClone({
    trim: version.trim,
    bleedMm: version.bleedMm,
    safeContentRegion: version.safeContentRegion,
    dpiMin: version.dpiMin,
    color: version.color,
    cropMarks: version.cropMarks,
    spine: version.spine,
    coverTemplate: version.coverTemplate,
    requiredBlankPages: version.requiredBlankPages,
  });
}

export function blankCount(
  draft: PrintProfileDraft,
  position: "before_interior" | "after_interior",
): number {
  return (
    draft.requiredBlankPages.find((item) => item.position === position)
      ?.count ?? 0
  );
}

export function withBlanks(
  draft: PrintProfileDraft,
  position: "before_interior" | "after_interior",
  raw: number,
): PrintProfileDraft {
  const count = Math.max(0, Math.min(4, Math.trunc(raw)));
  const others = draft.requiredBlankPages.filter(
    (item) => item.position !== position,
  );
  const blank = {
    position,
    count,
    label:
      position === "before_interior" ? "technical-front" : "technical-back",
  };
  return {
    ...draft,
    requiredBlankPages: count ? [...others, blank] : others,
  };
}

export function canSave(name: string, draft: PrintProfileDraft): boolean {
  return Boolean(
    name.trim() &&
    draft.spine.widthMm &&
    (draft.color.mode === "rgb" ||
      (draft.color.iccAssetId && draft.color.iccChecksum)),
  );
}

export function coverRegions(draft: PrintProfileDraft) {
  const spine = draft.spine.widthMm ?? 0;
  const total = draft.trim.widthMm * 2 + spine;
  return {
    backRegion: { x: 0, y: 0, width: draft.trim.widthMm / total, height: 1 },
    spineRegion: {
      x: draft.trim.widthMm / total,
      y: 0,
      width: spine / total,
      height: 1,
    },
    frontRegion: {
      x: (draft.trim.widthMm + spine) / total,
      y: 0,
      width: draft.trim.widthMm / total,
      height: 1,
    },
    toleranceMm: 0.5,
  };
}
