import type { MillimeterBox } from "../domain/print/geometry.js";
import type { PdfMechanicalFacts } from "./print-preflight-inspection.js";

export interface LayoutFindingEvidence {
  artifact: "interior" | "cover";
  page: number | null;
  expected: string | number;
  actual: string | number;
}

export function firstSafeMarginViolation(
  facts: PdfMechanicalFacts,
  safeBoxes: readonly MillimeterBox[],
  artifact: LayoutFindingEvidence["artifact"],
): LayoutFindingEvidence | null {
  if (!facts.parseable || facts.textBounds.length !== facts.pageCount)
    return finding(artifact, null, "text_bounds_for_every_page", "unavailable");
  for (const page of facts.textBounds) {
    if (page.wordCount === 0) continue;
    const unsafe = page.firstUnsafeWordBoundsMm;
    if (page.unsafeWordCount > 0 || unsafe)
      return finding(
        artifact,
        page.pageNumber,
        safeBoxes.map(boxSummary).join("|").slice(0, 120),
        boxSummary(unsafe),
      );
    if (
      safeBoxes.length === 1 &&
      (!page.boundsMm || !contains(safeBoxes[0], page.boundsMm, 0.5))
    )
      return finding(
        artifact,
        page.pageNumber,
        boxSummary(safeBoxes[0]),
        boxSummary(page.boundsMm),
      );
  }
  return null;
}

export function firstCropMarkMismatch(
  facts: PdfMechanicalFacts,
  expectedSegments: number,
  artifact: LayoutFindingEvidence["artifact"],
): LayoutFindingEvidence | null {
  if (!facts.parseable || facts.cropMarkSegments.length !== facts.pageCount)
    return finding(
      artifact,
      null,
      expectedSegments,
      "crop_evidence_unavailable",
    );
  const failed = facts.cropMarkSegments.find(
    (page) => page.detectedSegmentCount !== expectedSegments,
  );
  return failed
    ? finding(
        artifact,
        failed.pageNumber,
        expectedSegments,
        failed.detectedSegmentCount,
      )
    : null;
}

function contains(
  outer: MillimeterBox,
  inner: MillimeterBox,
  tolerance: number,
): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

function finding(
  artifact: LayoutFindingEvidence["artifact"],
  page: number | null,
  expected: LayoutFindingEvidence["expected"],
  actual: LayoutFindingEvidence["actual"],
): LayoutFindingEvidence {
  return { artifact, page, expected, actual };
}

function boxSummary(box: MillimeterBox | null): string {
  return box
    ? `${box.x},${box.y},${box.width},${box.height}`.slice(0, 120)
    : "missing";
}
