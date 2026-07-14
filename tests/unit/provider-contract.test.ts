import { describe, expect, it } from "vitest";

import {
  imageRequestDraftSchema,
  providerCapabilitiesSchema,
  resolvedImageRequestSchema,
  taskInputVersionRefs,
} from "../../src/providers/contract.js";
import { structuralDiagnostics } from "../../src/providers/diagnostics.js";
import {
  failureCategorySchema,
  makeFailure,
} from "../../src/providers/failures.js";
import {
  canonicalJson,
  createProvenance,
  settingsSnapshotHash,
} from "../../src/providers/provenance.js";
import { CHARACTER_A, generationTask } from "../helpers/provider-fixtures.js";

describe("provider-neutral contract", () => {
  it("keeps all canonical failures and derives retryability", () => {
    const categories = failureCategorySchema.options;
    expect(categories).toHaveLength(18);
    expect(makeFailure("timeout").retryable).toBe(true);
    expect(makeFailure("rate_limited").retryable).toBe(true);
    expect(makeFailure("quota_exhausted").retryable).toBe(false);
    expect(makeFailure("safety_refusal").retryable).toBe(false);
  });

  it("fails closed when real-image boundaries are unverified", () => {
    const capabilities = providerCapabilitiesSchema.parse({
      providerId: "gemini",
      checkedAt: "2026-07-14T12:00:00.000Z",
      source: "live",
      auth: { state: "ok", detail: "تم التحقق" },
      text: {
        available: true,
        structured: true,
        modelId: "gemini-test",
      },
      image: {
        available: false,
        modelId: "gemini-image-test",
        maxReferenceImages: null,
        reliableCharacterCount: null,
        economyTier: false,
        unavailableReason: "حدود الصور لم تُقَس بعد",
      },
      limits: { concurrencySuggested: 1 },
    });
    expect(capabilities.image.maxReferenceImages).toBeNull();
    expect(() =>
      providerCapabilitiesSchema.parse({
        ...capabilities,
        image: { ...capabilities.image, maxReferenceImages: 11 },
        inventedDefault: 7,
      }),
    ).toThrow();
  });

  it("accepts only ephemeral resolved image bytes and strict metadata", () => {
    const valid = {
      schemaVersion: 1,
      styleId: "modern_cartoon",
      scene: {
        pageNumber: 1,
        description: "نور في الحديقة",
        participants: [
          {
            characterRef: CHARACTER_A,
            action: "تجري",
            emotion: "سعيدة",
            lookId: "look-a",
          },
        ],
        environment: "حديقة",
        composition: "متوازنة",
        cameraFraming: "متوسط",
      },
      referenceImages: [
        {
          source: "reference_photo",
          sourceRecordId: "photo-1",
          customerId: "customer-1",
          familyId: "family-1",
          characterId: "character-a",
          versionRefs: { characterVersionId: "character-version-a" },
          provenanceAssetId: "asset-clean-1",
          mime: "image/png",
          bytes: new Uint8Array([137, 80, 78, 71]),
        },
      ],
      negativeConstraints: ["no_extra_people"],
      output: { minWidthPx: 2480, minHeightPx: 3508 },
    };
    expect(
      resolvedImageRequestSchema.parse(valid).referenceImages,
    ).toHaveLength(1);
    for (const forbidden of [
      { assetStore: {} },
      { localPath: "/private/child.png" },
      { originalAssetId: "original-1" },
    ]) {
      expect(() =>
        resolvedImageRequestSchema.parse({ ...valid, ...forbidden }),
      ).toThrow();
    }
  });

  it("keeps persisted image drafts serializable and free of bytes or load handles", () => {
    const scene = {
      pageNumber: 1,
      description: "نور في الحديقة",
      participants: [
        {
          characterRef: CHARACTER_A,
          action: "تجري",
          emotion: "سعيدة",
          lookId: "look-a",
        },
      ],
      environment: "حديقة",
      composition: "متوازنة",
      cameraFraming: "متوسط",
    };
    const draft = imageRequestDraftSchema.parse({
      styleId: "modern_cartoon",
      scene,
      referenceImages: [
        {
          source: "reference_photo",
          referencePhotoId: "photo-1",
          customerId: "customer-1",
          familyId: "family-1",
          characterId: "character-a",
          owner: {
            type: "look",
            lookId: "look-a",
            characterVersionId: "character-version-a",
            lookVersionId: "look-version-a",
          },
          providerAssetId: "asset-clean-1",
        },
        {
          source: "approved_character_sheet",
          characterSheetId: "sheet-1",
          customerId: "customer-1",
          familyId: "family-1",
          characterId: "character-a",
          characterVersionId: "character-version-a",
          appearance: {
            type: "shared_look",
            lookId: "look-a",
            lookVersionId: "look-version-a",
          },
          sheetAssetId: "asset-sheet-1",
        },
      ],
      negativeConstraints: ["no_extra_people"],
      output: { minWidthPx: 2480, minHeightPx: 3508 },
    });
    expect(JSON.parse(JSON.stringify(draft))).toEqual(draft);
    for (const forbidden of [
      { bytes: new Uint8Array([1]) },
      { localPath: "/private/original.png" },
      { assetStore: {} },
    ]) {
      expect(() =>
        imageRequestDraftSchema.parse({ ...draft, ...forbidden }),
      ).toThrow();
    }
    expect(taskInputVersionRefs(generationTask("StoryPlan"))).toEqual({
      project: "project-version-1",
      characterA: "character-version-a",
      characterB: "character-version-b",
    });
  });

  it("reports malformed shape without retaining values", () => {
    const privateValue = "PRIVATE-STORY-TEXT-CANARY";
    const diagnostics = structuralDiagnostics(
      JSON.stringify({ title: privateValue, nested: { child: privateValue } }),
      [{ path: ["nested", "child"], code: "invalid_type" }],
    );
    const serialized = JSON.stringify(diagnostics);
    expect(diagnostics).toMatchObject({
      byteCount: expect.any(Number),
      topLevelType: "object",
      topLevelKeys: ["nested", "title"],
    });
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain("child.png");
  });

  it("hashes settings canonically and creates immutable provenance", () => {
    const a = settingsSnapshotHash({ b: 2, a: { y: 1, x: true } });
    const b = settingsSnapshotHash({ a: { x: true, y: 1 }, b: 2 });
    expect(a).toBe(b);
    expect(() => canonicalJson(new Uint8Array([1, 2, 3]))).toThrow(
      "BINARY_CANONICALIZATION_FORBIDDEN",
    );
    const provenance = createProvenance({
      provider: "mock",
      modelId: "mock-v1",
      at: "2026-07-14T12:00:00.000Z",
      inputVersionRefs: { project: "project-version-1" },
      promptVersion: "prompt-v1",
      referenceAssetIds: ["asset-clean-1"],
      attempt: 1,
      settings: { textProvider: "mock", imageProvider: "mock" },
    });
    expect(provenance.settingsSnapshotHash).toHaveLength(64);
    expect(() =>
      createProvenance({ ...provenance, settings: {}, provider: "external" }),
    ).toThrow();
  });
});
