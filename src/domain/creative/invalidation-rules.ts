import type { MatrixRow } from "./schemas.js";

export const MATRIX_ROWS = [
  "IM-01",
  "IM-02",
  "IM-03",
  "IM-04",
  "IM-05",
  "IM-06",
  "IM-07",
  "IM-08",
  "IM-09",
  "IM-10",
  "IM-11",
  "IM-12",
  "IM-13",
  "IM-14",
  "IM-15",
  "IM-16",
  "IM-17",
  "IM-18",
  "IM-19",
  "IM-20",
  "IM-21",
] as const satisfies readonly MatrixRow[];

export type InvalidationArtifactKind =
  | "character_approval"
  | "character_sheet"
  | "story_plan_text"
  | "scene"
  | "page_illustration"
  | "page_layout"
  | "preview_pdf"
  | "book_approval"
  | "print_interior"
  | "print_cover"
  | "print_preflight";

type MatrixEffect = "invalidate" | "recheck";

interface InvalidationRule {
  effects: Partial<Record<InvalidationArtifactKind, MatrixEffect>>;
  bumpBookVersion: boolean;
}

export interface InvalidationArtifact {
  id: string;
  kind: InvalidationArtifactKind;
  locked: boolean;
}

export interface InvalidationConsequence {
  artifactId: string;
  kind: InvalidationArtifactKind;
  effect: "stale" | "locked_stale" | "recheck";
  actions: readonly (
    "regenerate" | "keep_stale" | "unlock_and_edit" | "review"
  )[];
}

export interface InvalidationEvaluation {
  row: MatrixRow;
  bumpBookVersion: boolean;
  consequences: InvalidationConsequence[];
}

export const invalidationRuleTable: Record<MatrixRow, InvalidationRule> = {
  "IM-01": rule(true, {
    character_approval: "invalidate",
    character_sheet: "invalidate",
    page_illustration: "invalidate",
    page_layout: "recheck",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-02": rule(false, {
    story_plan_text: "recheck",
    scene: "recheck",
  }),
  "IM-03": rule(true, {
    character_sheet: "invalidate",
    page_illustration: "invalidate",
    page_layout: "recheck",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-04": rule(true, {
    page_illustration: "invalidate",
    page_layout: "recheck",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-05": rule(true, {
    character_sheet: "recheck",
    story_plan_text: "recheck",
    scene: "recheck",
    page_layout: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-06": rule(true, {
    page_illustration: "invalidate",
    page_layout: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-07": rule(true, {
    page_layout: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-08": rule(true, {
    scene: "invalidate",
    page_illustration: "invalidate",
    page_layout: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-09": rule(true, {
    story_plan_text: "invalidate",
    scene: "invalidate",
    page_illustration: "invalidate",
    page_layout: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-10": rule(true, {
    page_layout: "recheck",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-11": rule(true, {
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-12": rule(true, {
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-13": rule(true, {
    character_sheet: "recheck",
    page_illustration: "invalidate",
    page_layout: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-14": rule(false, {
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-15": rule(false, { print_cover: "invalidate" }),
  "IM-16": rule(false, {}),
  "IM-17": rule(false, {}),
  "IM-18": rule(false, {}),
  "IM-19": rule(false, {
    preview_pdf: "invalidate",
    book_approval: "recheck",
  }),
  "IM-20": rule(false, {
    character_sheet: "invalidate",
    page_illustration: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "recheck",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-21": rule(false, {}),
};

export function evaluateInvalidation(
  row: MatrixRow,
  artifacts: readonly InvalidationArtifact[],
): InvalidationEvaluation {
  const rule = invalidationRuleTable[row];
  const consequences = artifacts.flatMap((artifact) => {
    const effect = rule.effects[artifact.kind];
    return effect ? [consequence(artifact, effect)] : [];
  });
  return { row, bumpBookVersion: rule.bumpBookVersion, consequences };
}

function rule(
  bumpBookVersion: boolean,
  effects: InvalidationRule["effects"],
): InvalidationRule {
  return { effects, bumpBookVersion };
}

function consequence(
  artifact: InvalidationArtifact,
  effect: MatrixEffect,
): InvalidationConsequence {
  if (effect === "recheck") {
    return {
      artifactId: artifact.id,
      kind: artifact.kind,
      effect: "recheck",
      actions: ["review"],
    };
  }
  if (
    artifact.locked &&
    (artifact.kind === "page_illustration" || artifact.kind === "page_layout")
  ) {
    return {
      artifactId: artifact.id,
      kind: artifact.kind,
      effect: "locked_stale",
      actions: ["keep_stale", "unlock_and_edit"],
    };
  }
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    effect: "stale",
    actions: ["regenerate", "keep_stale"],
  };
}
