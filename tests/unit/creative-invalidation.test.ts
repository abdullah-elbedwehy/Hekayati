import { describe, expect, it } from "vitest";

import {
  MATRIX_ROWS,
  evaluateInvalidation,
  invalidationRuleTable,
  type InvalidationArtifact,
  type InvalidationArtifactKind,
  type InvalidationConsequence,
} from "../../src/domain/creative/invalidation-rules.js";
import type { MatrixRow } from "../../src/domain/creative/schemas.js";

type ExpectedEffect = "invalidate" | "recheck";

interface ExpectedRule {
  bumpBookVersion: boolean;
  effects: Partial<Record<InvalidationArtifactKind, ExpectedEffect>>;
}

// This is intentionally an independent, literal transcription of IM-01..IM-21.
// Do not derive it from invalidationRuleTable: it is the executable oracle that
// catches additions, removals, and effect drift in the production table.
const EXPECTED_MATRIX = {
  "IM-01": expectedRule(true, {
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
  "IM-02": expectedRule(false, {
    story_plan_text: "recheck",
    scene: "recheck",
  }),
  "IM-03": expectedRule(true, {
    character_sheet: "invalidate",
    page_illustration: "invalidate",
    page_layout: "recheck",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-04": expectedRule(true, {
    page_illustration: "invalidate",
    page_layout: "recheck",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-05": expectedRule(true, {
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
  "IM-06": expectedRule(true, {
    page_illustration: "invalidate",
    page_layout: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-07": expectedRule(true, {
    page_layout: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-08": expectedRule(true, {
    scene: "invalidate",
    page_illustration: "invalidate",
    page_layout: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-09": expectedRule(true, {
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
  "IM-10": expectedRule(true, {
    page_layout: "recheck",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-11": expectedRule(true, downstreamBookArtifacts()),
  "IM-12": expectedRule(true, downstreamBookArtifacts()),
  "IM-13": expectedRule(true, {
    character_sheet: "recheck",
    page_illustration: "invalidate",
    page_layout: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-14": expectedRule(false, {
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-15": expectedRule(false, {
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-16": expectedRule(false, {}),
  "IM-17": expectedRule(false, {}),
  "IM-18": expectedRule(false, {}),
  "IM-19": expectedRule(false, {
    preview_pdf: "invalidate",
    book_approval: "recheck",
  }),
  "IM-20": expectedRule(false, {
    character_sheet: "invalidate",
    page_illustration: "invalidate",
    preview_pdf: "invalidate",
    book_approval: "recheck",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  }),
  "IM-21": expectedRule(false, {}),
} as const satisfies Record<MatrixRow, ExpectedRule>;

const ARTIFACTS: readonly InvalidationArtifact[] = [
  artifact("01J00000000000000000000001", "character_approval"),
  artifact("01J00000000000000000000002", "character_sheet"),
  artifact("01J00000000000000000000003", "story_plan_text"),
  artifact("01J00000000000000000000004", "scene"),
  artifact("01J00000000000000000000005", "page_illustration"),
  artifact("01J00000000000000000000006", "page_illustration", true),
  artifact("01J00000000000000000000007", "page_layout"),
  artifact("01J00000000000000000000008", "page_layout", true),
  artifact("01J00000000000000000000009", "preview_pdf"),
  artifact("01J00000000000000000000010", "book_approval"),
  artifact("01J00000000000000000000011", "print_interior"),
  artifact("01J00000000000000000000012", "print_cover"),
  artifact("01J00000000000000000000013", "print_preflight"),
  artifact("01J00000000000000000000014", "print_proof"),
  artifact("01J00000000000000000000015", "print_run"),
];

describe("creative invalidation matrix", () => {
  it("defines every canonical row exactly once and no non-canonical row", () => {
    expect(Object.keys(invalidationRuleTable)).toEqual(MATRIX_ROWS);
    expect(Object.keys(EXPECTED_MATRIX)).toEqual(MATRIX_ROWS);
    expect(new Set(Object.keys(invalidationRuleTable)).size).toBe(21);
  });

  it.each(MATRIX_ROWS)(
    "%s exactly matches the independent consequences, actions, and version bump oracle",
    (row) => {
      const expected = EXPECTED_MATRIX[row];
      const expectedConsequences = ARTIFACTS.flatMap((item) => {
        const effect = expected.effects[item.kind];
        return effect ? [expectedConsequence(item, effect)] : [];
      });

      expect(invalidationRuleTable[row]).toEqual(expected);
      expect(evaluateInvalidation(row, ARTIFACTS)).toEqual({
        row,
        bumpBookVersion: expected.bumpBookVersion,
        consequences: expectedConsequences,
      });

      // Explicitly prove that the page set is exact. This catches accidental
      // broad invalidation even if a non-page consequence happens to look valid.
      expect(
        evaluateInvalidation(row, ARTIFACTS)
          .consequences.filter((item) => item.kind.startsWith("page_"))
          .map((item) => ({
            id: item.artifactId,
            kind: item.kind,
            effect: item.effect,
            actions: item.actions,
          })),
      ).toEqual(
        expectedConsequences
          .filter((item) => item.kind.startsWith("page_"))
          .map((item) => ({
            id: item.artifactId,
            kind: item.kind,
            effect: item.effect,
            actions: item.actions,
          })),
      );
    },
  );

  it("is deterministic without mutating the supplied artifact set", () => {
    const before = structuredClone(ARTIFACTS);
    const first = MATRIX_ROWS.map((row) =>
      evaluateInvalidation(row, ARTIFACTS),
    );
    const replay = MATRIX_ROWS.map((row) =>
      evaluateInvalidation(row, ARTIFACTS),
    );

    expect(replay).toEqual(first);
    expect(ARTIFACTS).toEqual(before);
  });
});

function expectedRule(
  bumpBookVersion: boolean,
  effects: ExpectedRule["effects"],
): ExpectedRule {
  const finalizers = effects.print_preflight
    ? {
        print_proof: effects.print_preflight,
        print_run: effects.print_preflight,
      }
    : {};
  return { effects: { ...effects, ...finalizers }, bumpBookVersion };
}

function downstreamBookArtifacts(): ExpectedRule["effects"] {
  return {
    preview_pdf: "invalidate",
    book_approval: "invalidate",
    print_interior: "invalidate",
    print_cover: "invalidate",
    print_preflight: "invalidate",
  };
}

function artifact(
  id: string,
  kind: InvalidationArtifactKind,
  locked = false,
): InvalidationArtifact {
  return { id, kind, locked };
}

function expectedConsequence(
  item: InvalidationArtifact,
  effect: ExpectedEffect,
): InvalidationConsequence {
  if (effect === "recheck") {
    return {
      artifactId: item.id,
      kind: item.kind,
      effect: "recheck",
      actions: ["review"],
    };
  }
  if (
    item.locked &&
    (item.kind === "page_illustration" || item.kind === "page_layout")
  ) {
    return {
      artifactId: item.id,
      kind: item.kind,
      effect: "locked_stale",
      actions: ["keep_stale", "unlock_and_edit"],
    };
  }
  return {
    artifactId: item.id,
    kind: item.kind,
    effect: "stale",
    actions: ["regenerate", "keep_stale"],
  };
}
