import type { MillimeterBox } from "../domain/print/geometry.js";
import type { PdfMechanicalFacts } from "./print-preflight-inspection.js";

const BOX_TOLERANCE_MM = 0.2;

export interface GeometryFindingEvidence {
  artifact: "interior" | "cover";
  page: number | null;
  expected: string | number;
  actual: string | number;
}

type BoxField = "mediaBoxMm" | "bleedBoxMm" | "trimBoxMm";

export function firstBoxMismatch(
  actual: PdfMechanicalFacts,
  expected: Record<BoxField, MillimeterBox>,
  artifact: GeometryFindingEvidence["artifact"],
  fields: BoxField[],
): GeometryFindingEvidence | null {
  if (!actual.parseable)
    return evidence(artifact, null, "parseable_page_boxes", "unavailable");
  if (actual.pageBoxes.length !== actual.pageCount)
    return evidence(artifact, null, actual.pageCount, actual.pageBoxes.length);
  for (let pageNumber = 1; pageNumber <= actual.pageCount; pageNumber += 1) {
    const page = actual.pageBoxes.find(
      (candidate) => candidate.pageNumber === pageNumber,
    );
    if (!page) return evidence(artifact, pageNumber, "page_box", "missing");
    for (const field of fields)
      if (!boxEqual(page[field], expected[field]))
        return evidence(
          artifact,
          pageNumber,
          boxSummary(expected[field]),
          boxSummary(page[field]),
        );
  }
  return null;
}

export function firstOrientationMismatch(
  facts: PdfMechanicalFacts,
  artifact: GeometryFindingEvidence["artifact"],
  expectedPortrait: boolean,
): GeometryFindingEvidence | null {
  if (!facts.parseable)
    return evidence(artifact, null, "parseable_orientation", "unavailable");
  if (facts.pageBoxes.length !== facts.pageCount)
    return evidence(artifact, null, facts.pageCount, facts.pageBoxes.length);
  for (const page of facts.pageBoxes) {
    const rotation = normalizedRotation(page.rotation);
    const mediaPortrait = Boolean(
      page.mediaBoxMm && page.mediaBoxMm.width < page.mediaBoxMm.height,
    );
    if (rotation !== 0 || mediaPortrait !== expectedPortrait)
      return evidence(
        artifact,
        page.pageNumber,
        expectedPortrait ? "portrait,rotation=0" : "landscape,rotation=0",
        `${page.portrait ? "portrait" : "landscape"},rotation=${page.rotation ?? "missing"}`,
      );
  }
  return null;
}

export function firstLowPpi(
  facts: PdfMechanicalFacts,
  artifact: GeometryFindingEvidence["artifact"],
  required: number,
): GeometryFindingEvidence | null {
  const low = facts.imagePpi.find(
    (page) => page.minimumPpi === null || page.minimumPpi + 1e-6 < required,
  );
  if (low)
    return evidence(artifact, low.pageNumber, required, low.minimumPpi ?? 0);
  if (facts.minimumImagePpi !== null && facts.minimumImagePpi + 1e-6 < required)
    return evidence(artifact, null, required, facts.minimumImagePpi);
  return null;
}

function boxEqual(
  actual: MillimeterBox | null,
  expected: MillimeterBox,
): boolean {
  return Boolean(
    actual &&
    (["x", "y", "width", "height"] as const).every(
      (field) => Math.abs(actual[field] - expected[field]) <= BOX_TOLERANCE_MM,
    ),
  );
}

function boxSummary(box: MillimeterBox | null): string {
  return box
    ? `${box.x},${box.y},${box.width},${box.height}`.slice(0, 120)
    : "missing";
}

function normalizedRotation(value: number | null): number | null {
  if (value === null) return null;
  return ((value % 360) + 360) % 360;
}

function evidence(
  artifact: GeometryFindingEvidence["artifact"],
  page: number | null,
  expected: GeometryFindingEvidence["expected"],
  actual: GeometryFindingEvidence["actual"],
): GeometryFindingEvidence {
  return { artifact, page, expected, actual };
}
