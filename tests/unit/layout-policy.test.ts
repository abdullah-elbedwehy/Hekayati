import { describe, expect, it } from "vitest";

import {
  createApprovalBundleHash,
  createContentAuthorizationHash,
  createCustomerContentHash,
  createPageContentHash,
  createPreviewDerivativePolicyHash,
} from "../../src/domain/layout/hashes.js";
import {
  A4_COMPOSITION_PROFILE,
  resolveLayoutPolicy,
} from "../../src/domain/layout/policy.js";

const hash = (digit: string) => digit.repeat(64);

describe("layout policy", () => {
  it("pins the A4 portrait customer composition profile", () => {
    expect(A4_COMPOSITION_PROFILE).toMatchObject({
      version: "a4-portrait-v1",
      trimWidthMm: 210,
      trimHeightMm: 297,
      dimensionToleranceMm: 0.5,
    });
    expect(A4_COMPOSITION_PROFILE.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses deterministic physical placement and stable tie-breaking", () => {
    const input = {
      requestedPlacement: "auto" as const,
      ageBand: "age_6_8" as const,
      text: "مغامرة صغيرة في الحديقة",
      measurements: {
        top: { quietness: 0.82, contrast: 7.2 },
        bottom: { quietness: 0.82, contrast: 7.2 },
        right: { quietness: 0.7, contrast: 8 },
        left: { quietness: 0.6, contrast: 8 },
      },
      dialogue: [],
    };

    expect(resolveLayoutPolicy(input)).toEqual(resolveLayoutPolicy(input));
    expect(resolveLayoutPolicy(input)).toMatchObject({
      resolvedPlacement: "top",
      readabilityAid: "none",
      acceptance: "ready",
    });
    expect(
      resolveLayoutPolicy({ ...input, requestedPlacement: "left" }),
    ).toMatchObject({ resolvedPlacement: "left" });
  });

  it("applies aids before operator action and never shrinks below the floor", () => {
    const base = {
      requestedPlacement: "auto" as const,
      ageBand: "age_3_5" as const,
      measurements: {
        top: { quietness: 0.1, contrast: 1.2 },
        bottom: { quietness: 0.12, contrast: 1.1 },
        right: { quietness: 0.08, contrast: 1 },
        left: { quietness: 0.09, contrast: 1.3 },
      },
      dialogue: [],
    };
    const panel = resolveLayoutPolicy({ ...base, text: "نص قصير" });
    expect(panel).toMatchObject({
      readabilityAid: "panel",
      fontSizePt: 24,
      acceptance: "ready",
    });

    const overflow = resolveLayoutPolicy({
      ...base,
      text: "كلمة ".repeat(900),
    });
    expect(overflow.fontSizePt).toBe(14);
    expect(overflow).toMatchObject({
      overflow: true,
      acceptance: "needs_operator",
    });

    const gradient = resolveLayoutPolicy({
      ...base,
      text: "نص قصير",
      measurements: {
        ...base.measurements,
        top: { quietness: 0.4, contrast: 3.4 },
      },
    });
    expect(gradient).toMatchObject({
      resolvedPlacement: "top",
      readabilityAid: "gradient",
      acceptance: "ready",
    });
  });

  it("records an unsafe explicit preset instead of silently changing it", () => {
    const result = resolveLayoutPolicy({
      requestedPlacement: "right",
      ageBand: "age_9_12",
      text: "نص آمن",
      measurements: {
        top: { quietness: 0.9, contrast: 9 },
        bottom: { quietness: 0.8, contrast: 8 },
        right: { quietness: 0.2, contrast: 2, safeArea: false },
        left: { quietness: 0.7, contrast: 7 },
      },
      dialogue: [],
    });

    expect(result.resolvedPlacement).toBe("right");
    expect(result.acceptance).toBe("needs_operator");
    expect(result.warnings).toContain("NO_SAFE_TEXT_REGION");
  });

  it("chooses the strongest safe automatic region and makes an all-unsafe fallback explicit", () => {
    const measurements = {
      top: { quietness: 0.2, contrast: 2 },
      bottom: { quietness: 0.75, contrast: 18 },
      right: { quietness: 0.99, contrast: 20, safeArea: false },
      left: { quietness: 0.5, contrast: 4 },
    };
    expect(
      resolveLayoutPolicy({
        requestedPlacement: "auto",
        ageBand: "age_6_8",
        text: "نص قصير",
        measurements,
        dialogue: [],
      }),
    ).toMatchObject({ resolvedPlacement: "bottom", acceptance: "ready" });

    const allUnsafe = {
      top: { ...measurements.top, safeArea: false },
      bottom: { ...measurements.bottom, safeArea: false },
      right: { ...measurements.right, safeArea: false },
      left: { ...measurements.left, safeArea: false },
    } as const;
    expect(
      resolveLayoutPolicy({
        requestedPlacement: "auto",
        ageBand: "age_6_8",
        text: "نص قصير",
        measurements: allUnsafe,
        dialogue: [],
      }),
    ).toMatchObject({
      resolvedPlacement: "top",
      acceptance: "needs_operator",
      warnings: expect.arrayContaining(["NO_SAFE_TEXT_REGION"]),
    });
  });

  it("uses a labeled non-pointing dialogue fallback when position is unsafe", () => {
    const result = resolveLayoutPolicy({
      requestedPlacement: "bottom",
      ageBand: "age_6_8",
      text: "قالت ليلى: هيا بنا",
      measurements: {
        top: { quietness: 0.8, contrast: 8 },
        bottom: { quietness: 0.8, contrast: 8 },
        right: { quietness: 0.8, contrast: 8 },
        left: { quietness: 0.8, contrast: 8 },
      },
      dialogue: [
        {
          speakerCharacterId: "01J00000000000000000000001",
          speakerLabel: "ليلى",
          text: "هيا بنا",
          position: null,
        },
      ],
    });

    expect(result.bubbles[0]).toMatchObject({
      speakerLabel: "ليلى",
      pointerAnchor: null,
    });
    expect(result.warnings).toContain("SPEAKER_ANCHOR_INDETERMINATE");
  });

  it("honors finite normalized speaker coordinates and rejects every unsafe coordinate shape", () => {
    const common = {
      requestedPlacement: "bottom" as const,
      ageBand: "age_6_8" as const,
      text: "حوار",
      measurements: {
        top: { quietness: 0.8, contrast: 8 },
        bottom: { quietness: 0.8, contrast: 8 },
        right: { quietness: 0.8, contrast: 8 },
        left: { quietness: 0.8, contrast: 8 },
      },
    };
    const valid = resolveLayoutPolicy({
      ...common,
      dialogue: [dialogueAt({ x: 0, y: 1 }), dialogueAt({ x: 1, y: 0 })],
    });
    expect(valid.bubbles.map((bubble) => bubble.pointerAnchor)).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ]);
    expect(valid.warnings).not.toContain("SPEAKER_ANCHOR_INDETERMINATE");

    for (const position of [
      { x: Number.NaN, y: 0.5 },
      { x: 0.5, y: Number.NaN },
      { x: -0.01, y: 0.5 },
      { x: 1.01, y: 0.5 },
      { x: 0.5, y: -0.01 },
      { x: 0.5, y: 1.01 },
    ]) {
      const result = resolveLayoutPolicy({
        ...common,
        dialogue: [dialogueAt(position)],
      });
      expect(result.bubbles[0].pointerAnchor).toBeNull();
      expect(result.warnings).toContain("SPEAKER_ANCHOR_INDETERMINATE");
    }
  });
});

function dialogueAt(position: { x: number; y: number }) {
  return {
    speakerCharacterId: "01J00000000000000000000001",
    speakerLabel: "ليلى",
    text: "هيا بنا",
    position,
  };
}

describe("layout and approval hashes", () => {
  const customerInput = {
    compositionProfileHash: hash("1"),
    coverCompositionHash: hash("2"),
    pages: [
      {
        pageNumber: 1,
        pageContentHash: hash("3"),
        layoutHash: hash("4"),
        textSources: [
          {
            role: "title",
            entityId: "01J00000000000000000000001",
            versionId: "01J00000000000000000000002",
            contentHash: hash("5"),
          },
        ],
        sourceAssets: [
          {
            role: "artwork",
            assetId: "01J00000000000000000000003",
            checksum: hash("6"),
          },
        ],
      },
    ],
  };

  it("separates visible content, preview derivative, and authorization hashes", () => {
    const customerContentHash = createCustomerContentHash(customerInput);
    const rerenderedBundle = createApprovalBundleHash({
      previewOutputId: "01J00000000000000000000004",
      customerContentHash,
      reviewEvidenceHash: hash("7"),
      watermarkSettingsHash: hash("8"),
      previewDerivativePolicyHash: hash("9"),
    });
    const changedWatermarkBundle = createApprovalBundleHash({
      previewOutputId: "01J00000000000000000000005",
      customerContentHash,
      reviewEvidenceHash: hash("7"),
      watermarkSettingsHash: hash("a"),
      previewDerivativePolicyHash: hash("9"),
    });

    expect(changedWatermarkBundle).not.toBe(rerenderedBundle);
    expect(createCustomerContentHash(customerInput)).toBe(customerContentHash);

    const authorization = createContentAuthorizationHash({
      customerContentHash,
      previewOutputId: "01J00000000000000000000004",
      approvalCycleId: "01J00000000000000000000006",
      approvalGateJobId: "01J00000000000000000000007",
      approvedOutcome: "approved",
      reviewEvidenceHash: hash("7"),
    });
    expect(authorization).toBe(
      createContentAuthorizationHash({
        customerContentHash,
        previewOutputId: "01J00000000000000000000004",
        approvalCycleId: "01J00000000000000000000006",
        approvalGateJobId: "01J00000000000000000000007",
        approvedOutcome: "approved",
        reviewEvidenceHash: hash("7"),
      }),
    );
  });

  it("canonicalizes unordered source sets while retaining ordered pages", () => {
    const textSources = [
      {
        role: "title",
        entityId: "01J00000000000000000000001",
        versionId: "01J00000000000000000000002",
        contentHash: hash("1"),
      },
      {
        role: "body",
        entityId: "01J00000000000000000000003",
        versionId: "01J00000000000000000000004",
        contentHash: hash("2"),
      },
    ];
    const sourceAssets = [
      {
        role: "artwork",
        assetId: "01J00000000000000000000005",
        checksum: hash("3"),
      },
      {
        role: "identity",
        assetId: "01J00000000000000000000006",
        checksum: hash("4"),
      },
    ];

    expect(createPageContentHash({ textSources, sourceAssets })).toBe(
      createPageContentHash({
        textSources: [...textSources].reverse(),
        sourceAssets: [...sourceAssets].reverse(),
      }),
    );
    expect(
      createPreviewDerivativePolicyHash({
        version: "hekayati.preview-derivative.v1",
        format: "webp",
        quality: 82,
        targetPpi: 150,
        sizing: "exact_placed_size",
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});
