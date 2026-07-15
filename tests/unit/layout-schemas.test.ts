import { describe, expect, it } from "vitest";

import {
  projectSchema,
  projectV1Schema,
} from "../../src/domain/authoring/schemas.js";
import { pageSchema, pageV1Schema } from "../../src/domain/creative/schemas.js";
import {
  bookApprovalActionSchema,
  bookApprovalCycleSchema,
  layoutInputSnapshotSchema,
  normalizedRegionSchema,
} from "../../src/domain/layout/schemas.js";

const at = "2026-07-15T00:00:00.000Z";
const ids = Array.from(
  { length: 24 },
  (_, index) => `01J${String(index + 1).padStart(23, "0")}`,
);
const hash = (digit: string) => digit.repeat(64);

describe("layout persistence schemas", () => {
  it("separates strict legacy and canonical Project/Page documents", () => {
    const legacyProject = projectV1Schema.parse({
      ...projectIdentity(1),
      schemaVersion: 1,
    });
    expect(() => projectSchema.parse(legacyProject)).toThrow();
    expect(
      projectSchema.parse({
        ...projectIdentity(2),
        schemaVersion: 2,
        revision: 0,
        compositionProfileId: "00000000000000000000000000",
        currentCoverCompositionVersionId: null,
        currentPreviewOutputId: null,
        currentPreviewCycleId: null,
        currentContentApprovalId: null,
      }).revision,
    ).toBe(0);

    const legacyPage = { ...pageIdentity(), currentLayoutVersionId: ids[8] };
    expect(pageV1Schema.parse(legacyPage).currentLayoutVersionId).toBe(ids[8]);
    expect(() =>
      pageSchema.parse({ ...legacyPage, schemaVersion: 2 }),
    ).toThrow();
    expect(
      pageSchema.parse({ ...pageIdentity(), schemaVersion: 2 }),
    ).not.toHaveProperty("currentLayoutVersionId");
  });

  it("requires story review evidence and forbids it for special-page selection", () => {
    const common = layoutInput();
    expect(
      layoutInputSnapshotSchema.parse({
        ...common,
        selectionSource: "not_applicable",
        pageReviewId: ids[8],
        reviewHash: hash("8"),
        compositionSourcePolicyVersion: null,
      }).selectionSource,
    ).toBe("not_applicable");
    expect(() =>
      layoutInputSnapshotSchema.parse({
        ...common,
        selectionSource: "automatic_v1",
        pageReviewId: ids[8],
        reviewHash: hash("8"),
        compositionSourcePolicyVersion: "hekayati.composition-source.v1",
      }),
    ).toThrow();
    expect(
      layoutInputSnapshotSchema.parse({
        ...common,
        selectionSource: "operator",
        pageReviewId: null,
        reviewHash: null,
        compositionSourcePolicyVersion: "hekayati.composition-source.v1",
      }).selectionSource,
    ).toBe("operator");
  });

  it("rejects out-of-canvas normalized geometry and unknown content", () => {
    expect(() =>
      normalizedRegionSchema.parse({ x: 0.8, y: 0, width: 0.3, height: 1 }),
    ).toThrow("REGION_WIDTH_OUT_OF_BOUNDS");
    expect(() =>
      normalizedRegionSchema.parse({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        bleedMm: 3,
      }),
    ).toThrow();
  });

  it("enforces strict change scopes, invalidation evidence, and paired authorization fences", () => {
    const cycle = approvalCycle();
    expect(() =>
      bookApprovalCycleSchema.parse({
        ...cycle,
        state: "changes_requested",
        notes: " ",
        affectedScopes: [],
      }),
    ).toThrow();
    expect(() =>
      bookApprovalCycleSchema.parse({
        ...cycle,
        state: "changes_requested",
        notes: "تعديل الصفحة",
        affectedScopes: [
          { kind: "page", pageId: ids[10] },
          { kind: "page", pageId: ids[10] },
        ],
      }),
    ).toThrow("APPROVAL_SCOPE_DUPLICATE");
    expect(() =>
      bookApprovalCycleSchema.parse({
        ...cycle,
        state: "invalidated",
        invalidatedBy: null,
      }),
    ).toThrow("APPROVAL_INVALIDATION_REQUIRED");
    expect(
      bookApprovalCycleSchema.parse({
        ...cycle,
        state: "changes_requested",
        notes: "تعديل محدد",
        affectedScopes: [
          { kind: "page", pageId: ids[10] },
          { kind: "cover", side: "front" },
        ],
      }).affectedScopes,
    ).toHaveLength(2);

    const action = approvalAction();
    expect(() =>
      bookApprovalActionSchema.parse({
        ...action,
        expectedContentApprovalId: ids[11],
        expectedContentApprovalRevision: null,
      }),
    ).toThrow("CONTENT_APPROVAL_EXPECTATION_MISMATCH");
    expect(() =>
      bookApprovalActionSchema.parse({
        ...action,
        affectedScopes: [
          { kind: "cover", side: "both" },
          { kind: "cover", side: "both" },
        ],
      }),
    ).toThrow("APPROVAL_SCOPE_DUPLICATE");
  });
});

function projectIdentity(schemaVersion: 1 | 2) {
  return {
    id: ids[0],
    createdAt: at,
    updatedAt: at,
    customerId: ids[1],
    familyId: ids[2],
    status: "draft" as const,
    priority: 0,
    paused: false,
    currentVersionId: ids[3],
    bookVersion: 1,
    printerProfileId: null,
    schemaVersion,
  };
}

function pageIdentity() {
  return {
    id: ids[4],
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 4,
    projectId: ids[0],
    pageNumber: 3,
    storyPageIndex: 1,
    kind: "story" as const,
    locked: true,
    reviewStatus: "approved" as const,
    staleState: "current" as const,
    staleReasons: [],
    currentTextVersionId: ids[5],
    currentPromptVersionId: ids[6],
    currentIllustrationVersionId: ids[7],
  };
}

function layoutInput() {
  return {
    compositionProfileId: "00000000000000000000000000",
    compositionProfileHash: hash("1"),
    projectVersionId: ids[3],
    pageObservationRevision: 4,
    pageContentHash: hash("2"),
    textVersionId: ids[5],
    illustrationVersionId: ids[7],
    templateVersion: "story-v1",
    compositionInputHash: hash("3"),
    textSources: [
      {
        role: "story_text",
        entityId: ids[4],
        versionId: ids[5],
        contentHash: hash("4"),
      },
    ],
    sourceAssets: [{ role: "artwork", assetId: ids[7], checksum: hash("5") }],
    typographySettingsHash: hash("6"),
    fontManifestHash: hash("7"),
  };
}

function approvalCycle() {
  return {
    id: ids[12],
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    projectId: ids[0],
    previewOutputId: ids[13],
    approvalGateJobId: ids[14],
    targetBookVersion: 3,
    customerContentHash: hash("a"),
    approvalBundleHash: hash("b"),
    pageMapHash: hash("c"),
    previewSnapshotHash: hash("d"),
    coverCompositionVersionId: ids[15],
    watermarkSettingsHash: hash("e"),
    state: "ready_to_send" as const,
    notes: "",
    affectedScopes: [],
    recordedAt: at,
    invalidatedBy: null,
    attentionReasons: [],
  };
}

function approvalAction() {
  return {
    id: ids[16],
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    cycleId: ids[12],
    idempotencyKey: "synthetic-action",
    canonicalRequestHash: hash("1"),
    action: "preview_sent" as const,
    projectRevision: 2,
    previewOutputRevision: 0,
    approvalRevision: 0,
    gateRevision: 0,
    expectedContentApprovalId: null,
    expectedContentApprovalRevision: null,
    previewOutputId: ids[13],
    approvalGateJobId: ids[14],
    customerContentHash: hash("a"),
    approvalBundleHash: hash("b"),
    normalizedNotes: "",
    affectedScopes: [],
    result: {
      projectRevision: 3,
      previewOutputRevision: 0,
      approvalRevision: 1,
      gateRevision: 0,
      currentContentApprovalId: null,
      projectStatus: "preview_ready" as const,
      approvalState: "preview_sent" as const,
      gateState: "waiting_review" as const,
    },
    recordedAt: at,
  };
}
