import type { PrinterBlankRule, PrinterProfileDraft } from "./types.js";

export interface MillimeterBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropMarkSegment {
  edge: "top" | "right" | "bottom" | "left";
  from: { x: number; y: number };
  to: { x: number; y: number };
  strokePt: number;
}

export interface InteriorGeometry {
  mediaBoxMm: MillimeterBox;
  bleedBoxMm: MillimeterBox;
  trimBoxMm: MillimeterBox;
  safeBoxMm: MillimeterBox;
  cropMarkMarginMm: number;
  cropMarks: CropMarkSegment[];
}

export interface CoverGeometry extends InteriorGeometry {
  spineWidthMm: number;
  panels: Array<{
    kind: "back" | "spine" | "front";
    boxMm: MillimeterBox;
    safeBoxMm: MillimeterBox;
  }>;
  foldLinesMm: number[];
}

export interface CustomerPageReference {
  customerPageNumber: number;
  pageId: string;
}

export type OutputPageMapEntry =
  | {
      kind: "customer";
      outputPageNumber: number;
      customerPageNumber: number;
      pageId: string;
      label: null;
    }
  | {
      kind: "printer_blank";
      outputPageNumber: number;
      customerPageNumber: null;
      pageId: null;
      label: string;
    };

type OutputPageMapEntryWithoutIndex =
  | Omit<Extract<OutputPageMapEntry, { kind: "customer" }>, "outputPageNumber">
  | Omit<
      Extract<OutputPageMapEntry, { kind: "printer_blank" }>,
      "outputPageNumber"
    >;

type GeometryProfile = Pick<
  PrinterProfileDraft,
  "trim" | "bleedMm" | "safeContentRegion" | "cropMarks" | "spine"
>;

export function compileInteriorGeometry(
  profile: GeometryProfile,
): InteriorGeometry {
  const cropMarkMarginMm = profile.cropMarks.enabled
    ? profile.cropMarks.offsetMm + profile.cropMarks.lengthMm
    : 0;
  const trimOffset = profile.bleedMm + cropMarkMarginMm;
  const mediaBoxMm = box(
    0,
    0,
    profile.trim.widthMm + trimOffset * 2,
    profile.trim.heightMm + trimOffset * 2,
  );
  const bleedBoxMm = box(
    cropMarkMarginMm,
    cropMarkMarginMm,
    profile.trim.widthMm + profile.bleedMm * 2,
    profile.trim.heightMm + profile.bleedMm * 2,
  );
  const trimBoxMm = box(
    trimOffset,
    trimOffset,
    profile.trim.widthMm,
    profile.trim.heightMm,
  );
  return {
    mediaBoxMm,
    bleedBoxMm,
    trimBoxMm,
    safeBoxMm: mapNormalized(trimBoxMm, profile.safeContentRegion),
    cropMarkMarginMm,
    cropMarks: compileCropMarks(trimBoxMm, profile),
  };
}

export function compileCoverGeometry(profile: GeometryProfile): CoverGeometry {
  const spineWidthMm = profile.spine.widthMm;
  if (!spineWidthMm || spineWidthMm <= 0)
    throw new Error("SPINE_WIDTH_UNKNOWN");
  const spreadProfile: GeometryProfile = {
    ...profile,
    trim: {
      ...profile.trim,
      widthMm: profile.trim.widthMm * 2 + spineWidthMm,
    },
  };
  const geometry = compileInteriorGeometry(spreadProfile);
  const origin = geometry.trimBoxMm.x;
  const back = box(
    origin,
    geometry.trimBoxMm.y,
    profile.trim.widthMm,
    profile.trim.heightMm,
  );
  const spine = box(
    origin + profile.trim.widthMm,
    geometry.trimBoxMm.y,
    spineWidthMm,
    profile.trim.heightMm,
  );
  const front = box(
    spine.x + spine.width,
    geometry.trimBoxMm.y,
    profile.trim.widthMm,
    profile.trim.heightMm,
  );
  return {
    ...geometry,
    spineWidthMm,
    panels: [
      coverPanel("back", back, profile.safeContentRegion),
      coverPanel("spine", spine, profile.safeContentRegion),
      coverPanel("front", front, profile.safeContentRegion),
    ],
    foldLinesMm: [spine.x, front.x],
  };
}

function coverPanel(
  kind: "back" | "spine" | "front",
  boxMm: MillimeterBox,
  safeRegion: { x: number; y: number; width: number; height: number },
): CoverGeometry["panels"][number] {
  return { kind, boxMm, safeBoxMm: mapNormalized(boxMm, safeRegion) };
}

export function compileOutputPageMap(
  customerPages: readonly CustomerPageReference[],
  blankRules: readonly PrinterBlankRule[],
): OutputPageMapEntry[] {
  if (customerPages.length !== 16 && customerPages.length !== 24)
    throw new Error("PRINT_CUSTOMER_PAGE_COUNT_INVALID");
  const numbers = customerPages.map((page) => page.customerPageNumber);
  if (
    numbers.some((number, index) => number !== index + 1) ||
    new Set(customerPages.map((page) => page.pageId)).size !==
      customerPages.length
  )
    throw new Error("PRINT_CUSTOMER_PAGE_MAP_INVALID");
  const before = blankRules.find((rule) => rule.position === "before_interior");
  const after = blankRules.find((rule) => rule.position === "after_interior");
  if (
    blankRules.length !== new Set(blankRules.map((rule) => rule.position)).size
  )
    throw new Error("PRINTER_BLANK_POSITION_DUPLICATE");
  const raw: OutputPageMapEntryWithoutIndex[] = [
    ...blankEntries(before),
    ...customerPages.map(
      (page) =>
        ({
          kind: "customer",
          customerPageNumber: page.customerPageNumber,
          pageId: page.pageId,
          label: null,
        }) as const,
    ),
    ...blankEntries(after),
  ];
  return raw.map((entry, index): OutputPageMapEntry =>
    entry.kind === "customer"
      ? { ...entry, outputPageNumber: index + 1 }
      : { ...entry, outputPageNumber: index + 1 },
  );
}

function blankEntries(
  rule: PrinterBlankRule | undefined,
): Array<
  Omit<
    Extract<OutputPageMapEntry, { kind: "printer_blank" }>,
    "outputPageNumber"
  >
> {
  if (!rule) return [];
  return Array.from({ length: rule.count }, (_, index) => ({
    kind: "printer_blank",
    customerPageNumber: null,
    pageId: null,
    label: rule.count === 1 ? rule.label : `${rule.label}-${index + 1}`,
  }));
}

function mapNormalized(
  outer: MillimeterBox,
  region: { x: number; y: number; width: number; height: number },
): MillimeterBox {
  return box(
    outer.x + outer.width * region.x,
    outer.y + outer.height * region.y,
    outer.width * region.width,
    outer.height * region.height,
  );
}

function compileCropMarks(
  trim: MillimeterBox,
  profile: GeometryProfile,
): CropMarkSegment[] {
  if (!profile.cropMarks.enabled) return [];
  const { offsetMm, lengthMm, strokePt } = profile.cropMarks;
  const left = trim.x;
  const right = trim.x + trim.width;
  const top = trim.y;
  const bottom = trim.y + trim.height;
  const horizontal = (y: number, x: number, direction: -1 | 1) => ({
    edge: direction < 0 ? ("left" as const) : ("right" as const),
    from: { x: x + direction * offsetMm, y },
    to: { x: x + direction * (offsetMm + lengthMm), y },
    strokePt,
  });
  const vertical = (x: number, y: number, direction: -1 | 1) => ({
    edge: direction < 0 ? ("top" as const) : ("bottom" as const),
    from: { x, y: y + direction * offsetMm },
    to: { x, y: y + direction * (offsetMm + lengthMm) },
    strokePt,
  });
  return [
    horizontal(top, left, -1),
    horizontal(bottom, left, -1),
    horizontal(top, right, 1),
    horizontal(bottom, right, 1),
    vertical(left, top, -1),
    vertical(right, top, -1),
    vertical(left, bottom, 1),
    vertical(right, bottom, 1),
  ];
}

function box(
  x: number,
  y: number,
  width: number,
  height: number,
): MillimeterBox {
  return { x, y, width, height };
}
