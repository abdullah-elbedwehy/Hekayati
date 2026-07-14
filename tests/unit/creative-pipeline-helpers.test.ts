import { describe, expect, it, vi } from "vitest";

import { creativeCapacityBindingHash } from "../../src/contracts/creative-policy.js";
import {
  approvedSheetsForWorkspace,
  buildPageImageDraft,
} from "../../src/domain/creative/pipeline-image.js";
import {
  acknowledgeCreativeFinding,
  creativeFindingProjection,
} from "../../src/domain/creative/pipeline-review.js";
import {
  approvalGateJobIds,
  assertPageSnapshot,
  internalReviewCanComplete,
  updateCreativeProjectStatus,
} from "../../src/domain/creative/pipeline-guards.js";
import { assertRunStartVersions } from "../../src/domain/creative/pipeline-run-start.js";
import { CreativeStageStore } from "../../src/domain/creative/pipeline-stages.js";
import {
  selectedImageTarget,
  selectedStructuredTarget,
} from "../../src/domain/creative/targets.js";
import type { CharacterSheet } from "../../src/domain/creative/schemas.js";
import type { JobRecord } from "../../src/jobs/schemas.js";
import type { SettingsService } from "../../src/domain/settings/settings.js";

const at = "2026-07-14T00:00:00.000Z";
const hash = "a".repeat(64);
const id = (index: number) => `01J${String(index).padStart(23, "0")}`;

describe("creative pipeline helper boundaries", () => {
  it("selects only the newest exact sheet and rechecks photo consent", () => {
    const library = { assertPhotoConsent: vi.fn() };
    const old = sheet({ id: id(20), createdAt: "2026-07-13T00:00:00.000Z" });
    const newest = sheet({
      id: id(21),
      createdAt: at,
      referenceLineage: {
        source: "photo_derived",
        referencePhotoIds: [id(30)],
      },
    });

    expect(
      approvedSheetsForWorkspace(
        workspace({ appearance: baseAppearance }) as never,
        [old, newest],
        library as never,
      ),
    ).toEqual([newest]);
    expect(library.assertPhotoConsent).toHaveBeenCalledWith(
      newest.customerId,
      "photo_derived_sheet",
    );
  });

  it("rejects absent, base-mismatched, and shared-look-mismatched sheets", () => {
    expect(() =>
      approvedSheetsForWorkspace(
        workspace({ appearance: baseAppearance }) as never,
        [],
        { assertPhotoConsent: vi.fn() } as never,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_SHEET_NOT_APPROVED" }),
    );
    expect(() =>
      approvedSheetsForWorkspace(
        workspace({ appearance: baseAppearance }) as never,
        [sheet({ appearance: sharedAppearance })],
        { assertPhotoConsent: vi.fn() } as never,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_SHEET_NOT_APPROVED" }),
    );

    const expected = sharedAppearance;
    const candidates = [
      sheet({ appearance: baseAppearance }),
      sheet({
        id: id(22),
        appearance: { ...expected, lookId: id(91) },
      }),
      sheet({
        id: id(23),
        appearance: { ...expected, lookVersionId: id(92) },
      }),
      sheet({ id: id(24), appearance: expected }),
    ];
    expect(
      approvedSheetsForWorkspace(
        workspace({ appearance: expected }) as never,
        candidates,
        { assertPhotoConsent: vi.fn() } as never,
      ),
    ).toEqual([candidates[3]]);
  });

  it("builds only page-scoped approved references and rejects broken plans", () => {
    const selectedSheet = sheet({ appearance: baseAppearance });
    const otherCharacterId = id(60);
    const plan = capacityPlan([
      {
        characterId,
        requestedAssetIds: [selectedSheet.views.face],
        selectedAssetIds: [selectedSheet.views.face],
      },
      {
        characterId: otherCharacterId,
        requestedAssetIds: [id(61)],
        selectedAssetIds: [id(61)],
      },
    ]);
    const draft = buildPageImageDraft({
      workspace: workspace({ appearance: baseAppearance }) as never,
      sceneList: sceneList() as never,
      prompt: pagePrompt(characterId) as never,
      approvedSheets: [selectedSheet],
      capacityPlan: plan,
    });
    expect(draft.scene.description).toBe("وصف الصورة النهائي الآمن");
    expect(draft.referenceImages).toEqual([
      expect.objectContaining({
        characterId,
        sheetAssetId: selectedSheet.views.face,
      }),
    ]);

    expect(() =>
      buildPageImageDraft({
        workspace: workspace({ appearance: baseAppearance }) as never,
        sceneList: sceneList() as never,
        prompt: pagePrompt(characterId) as never,
        approvedSheets: [],
        capacityPlan: capacityPlan([
          {
            characterId,
            requestedAssetIds: [selectedSheet.views.face],
            selectedAssetIds: [selectedSheet.views.face],
          },
        ]),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_SHEET_NOT_APPROVED" }),
    );

    expect(() =>
      buildPageImageDraft({
        workspace: workspace({ appearance: baseAppearance }) as never,
        sceneList: sceneList() as never,
        prompt: pagePrompt(characterId) as never,
        approvedSheets: [selectedSheet],
        capacityPlan: capacityPlan([
          {
            characterId,
            requestedAssetIds: [id(99)],
            selectedAssetIds: [id(99)],
          },
        ]),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CREATIVE_SHEET_REFERENCE_MISMATCH",
      }),
    );
  });

  it("requires every review completion fence and a current approved page", () => {
    const run = {
      revision: 4,
      internalReviewGateJobId: id(70),
      status: "internal_review",
    };
    const page = {
      reviewStatus: "approved",
      staleState: "current",
      currentIllustrationVersionId: id(71),
    };
    const canComplete = (
      candidateRun: unknown,
      expectedRunRevision: number,
      gateJobId: string,
      pages: unknown[],
      blocked: boolean,
    ) =>
      internalReviewCanComplete(
        candidateRun as never,
        { expectedRunRevision },
        gateJobId,
        pages as never,
        blocked,
      );
    expect(canComplete(run, 4, id(70), [page], false)).toBe(true);
    expect(canComplete(run, 3, id(70), [page], false)).toBe(false);
    expect(canComplete(run, 4, id(72), [page], false)).toBe(false);
    expect(
      canComplete({ ...run, status: "generating" }, 4, id(70), [page], false),
    ).toBe(false);
    expect(canComplete(run, 4, id(70), [], false)).toBe(false);
    for (const changed of [
      { reviewStatus: "flagged" },
      { staleState: "stale" },
      { currentIllustrationVersionId: null },
    ])
      expect(
        canComplete(run, 4, id(70), [{ ...page, ...changed }], false),
      ).toBe(false);
    expect(canComplete(run, 4, id(70), [page], true)).toBe(false);
  });

  it("requires a succeeded approval gate for every selected sheet", () => {
    const intent = { approvalGateJobId: id(80) };
    const repositories = {
      sheetIntents: { queryByField: vi.fn(() => [intent]) },
    };
    const scheduler = {
      get: vi.fn(() => ({ id: id(80), state: "succeeded" })),
    };
    expect(
      approvalGateJobIds(
        [{ id: id(81) }],
        repositories as never,
        scheduler as never,
      ),
    ).toEqual([id(80)]);

    for (const fixture of [
      { intents: [], gate: null },
      { intents: [{ approvalGateJobId: null }], gate: null },
      { intents: [intent], gate: { id: id(80), state: "failed" } },
    ])
      expect(() =>
        approvalGateJobIds(
          [{ id: id(81) }],
          {
            sheetIntents: {
              queryByField: () => fixture.intents,
            },
          } as never,
          { get: () => fixture.gate } as never,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "CREATIVE_SHEET_NOT_APPROVED" }),
      );
  });

  it("rejects every stale page snapshot dimension before generation", () => {
    const page = {
      revision: 2,
      currentTextVersionId: id(82),
      currentPromptVersionId: id(83),
      locked: false,
      staleState: "current",
    };
    const pages = { getPage: vi.fn(() => page) };
    const check = (inputSnapshot: Record<string, string>) =>
      assertPageSnapshot(
        pages as never,
        { inputSnapshot } as JobRecord,
        id(84),
      );
    expect(() => check({})).not.toThrow();
    expect(() => check({ pageRevision: "r1" })).toThrowError(
      expect.objectContaining({ code: "CREATIVE_REVISION_CONFLICT" }),
    );
    expect(() => check({ textVersion: id(85) })).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    expect(() => check({ promptVersion: id(86) })).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    page.locked = true;
    expect(() => check({})).toThrowError(
      expect.objectContaining({ code: "CREATIVE_PAGE_LOCKED" }),
    );
    page.locked = false;
    page.staleState = "stale";
    expect(() => check({})).toThrowError(
      expect.objectContaining({ code: "CREATIVE_PAGE_LOCKED" }),
    );
  });

  it("updates only an existing creative project", () => {
    const update = vi.fn();
    updateCreativeProjectStatus(
      {
        projects: {
          get: () => ({ id: id(90), status: "draft", updatedAt: at }),
          update,
        },
      } as never,
      id(90),
      "generating",
      at,
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "generating", updatedAt: at }),
    );
    expect(() =>
      updateCreativeProjectStatus(
        { projects: { get: () => null, update } } as never,
        id(91),
        "generating",
        at,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_ENTITY_NOT_FOUND" }),
    );
  });

  it("acknowledges an exact finding once and rejects stale review actions", () => {
    const finding = {
      scope: "page",
      refId: id(10),
      pageNumber: 1,
      category: "safety",
      severity: "block",
      excerpt: "مقتطف اصطناعي",
      note: "مراجعة مطلوبة",
    };
    const acknowledgements: unknown[] = [];
    const run = { id: id(11), revision: 2, status: "internal_review" };
    const context = {
      repositories: {
        runs: { get: vi.fn(() => run) },
        acknowledgements: {
          queryByField: vi.fn(() => acknowledgements),
          insert: vi.fn((value) => {
            acknowledgements.push(value);
            return value;
          }),
        },
      },
      stages: {
        reviewFindings: vi.fn(() => ({
          schemaVersion: 1,
          findings: [finding],
        })),
      },
      now: () => at,
      idFactory: () => id(12),
    };
    const projected = creativeFindingProjection(context as never, run.id);
    expect(projected[0]).toMatchObject({ acknowledged: false });
    const input = {
      runId: run.id,
      expectedRunRevision: 2,
      findingKey: projected[0].key,
      note: "تمت المراجعة",
    };
    const first = acknowledgeCreativeFinding(context as never, input);
    expect(
      creativeFindingProjection(context as never, run.id)[0],
    ).toMatchObject({
      acknowledged: true,
    });
    expect(acknowledgeCreativeFinding(context as never, input)).toBe(first);
    expect(context.repositories.acknowledgements.insert).toHaveBeenCalledOnce();

    expect(() =>
      acknowledgeCreativeFinding(context as never, { ...input, note: " " }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_FINDINGS_BLOCK" }),
    );
    expect(() =>
      acknowledgeCreativeFinding(context as never, {
        ...input,
        expectedRunRevision: 1,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_REVISION_CONFLICT" }),
    );
    run.status = "complete";
    expect(() =>
      acknowledgeCreativeFinding(context as never, input),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_RUN_STATE_INVALID" }),
    );
    run.status = "internal_review";
    expect(() =>
      acknowledgeCreativeFinding(context as never, {
        ...input,
        findingKey: hash,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_ENTITY_NOT_FOUND" }),
    );
    context.repositories.runs.get.mockReturnValueOnce(null as never);
    expect(() =>
      acknowledgeCreativeFinding(context as never, input),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_ENTITY_NOT_FOUND" }),
    );
  });

  it("selects every configured provider target without substitution", () => {
    expect(
      selectedStructuredTarget(settings({ textProvider: "mock" }) as never),
    ).toMatchObject({
      providerId: "mock",
      modelId: "mock-v1",
    });
    expect(
      selectedStructuredTarget(settings({ textProvider: "codex" }) as never),
    ).toMatchObject({
      providerId: "codex",
      modelId: "codex-model",
    });
    expect(
      selectedStructuredTarget(settings({ textProvider: "gemini" }) as never),
    ).toMatchObject({
      providerId: "gemini",
      modelId: "gemini-text",
    });
    expect(
      selectedImageTarget(settings({ imageProvider: "mock" }) as never),
    ).toMatchObject({
      providerId: "mock",
      modelId: "mock-image-v1",
    });
    expect(
      selectedImageTarget(
        settings({
          imageProvider: "gemini",
          geminiImageTier: "economy",
        }) as never,
      ),
    ).toMatchObject({ providerId: "gemini", modelId: "gemini-economy" });
    expect(
      selectedImageTarget(
        settings({
          imageProvider: "gemini",
          geminiImageTier: "default",
        }) as never,
      ),
    ).toMatchObject({ providerId: "gemini", modelId: "gemini-image" });
    expect(() =>
      selectedImageTarget(settings({ imageProvider: "codex" }) as never),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_RUN_STATE_INVALID" }),
    );
  });

  it("requires exact run-start versions and exact stage page selection", () => {
    const exactWorkspace = workspace({ appearance: baseAppearance });
    expect(() =>
      assertRunStartVersions(exactWorkspace as never, {
        expectedProjectVersionId: exactWorkspace.version.id,
        expectedStoryVersionId: exactWorkspace.storyVersion.id,
      }),
    ).not.toThrow();
    expect(() =>
      assertRunStartVersions(exactWorkspace as never, {
        expectedProjectVersionId: id(98),
        expectedStoryVersionId: exactWorkspace.storyVersion.id,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );

    const records = [
      { runId: id(1), pageNumber: 1, output: { kind: "page_prompt" } },
      { runId: id(1), pageNumber: 2, output: { kind: "page_prompt" } },
    ];
    const stages = new CreativeStageStore(
      { stages: { queryByField: () => records } } as never,
      () => at,
      () => id(2),
    );
    expect(stages.get(id(1), "page_prompt")).toBe(records[0]);
    expect(stages.get(id(1), "page_prompt", 2)).toBe(records[1]);
    expect(() => stages.get(id(1), "scene_list")).toThrowError(
      expect.objectContaining({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" }),
    );
  });
});

const characterId = id(1);
const characterVersionId = id(2);
const baseAppearance = {
  type: "base" as const,
  lookId: null,
  lookVersionId: null,
};
const sharedAppearance = {
  type: "shared_look" as const,
  lookId: id(3),
  lookVersionId: id(4),
};

function workspace({ appearance }: { appearance: unknown }) {
  return {
    project: { id: id(5), customerId: id(6), familyId: id(7) },
    version: {
      id: id(8),
      storyConfig: {
        illustrationStyleId: "modern_cartoon",
        participants: [{ characterId, characterVersionId, appearance }],
      },
    },
    storyVersion: { id: id(9) },
  };
}

function sheet(overrides: Partial<CharacterSheet> = {}): CharacterSheet {
  return {
    id: id(10),
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    projectId: id(5),
    customerId: id(6),
    familyId: id(7),
    characterId,
    characterVersionId,
    appearance: baseAppearance,
    characterName: "نور",
    views: {
      face: id(40),
      front: id(41),
      threeQuarter: id(42),
      fullBody: id(43),
      mainOutfit: id(44),
    },
    referenceThumbnailAssetIds: [],
    referenceLineage: { source: "description_only", referencePhotoIds: [] },
    pdfAssetId: id(45),
    status: "approved",
    priorSheetId: null,
    generationJobIds: [id(46), id(47), id(48), id(49), id(50), id(51)],
    provenanceByView: {},
    ...overrides,
  };
}

function sceneList() {
  return {
    schemaVersion: 1,
    scenes: [
      {
        pageNumber: 1,
        description: "وصف المشهد",
        perCharacter: [
          {
            characterRef: { characterId, characterVersionId },
            action: "تجري",
            emotion: "سعيدة",
            lookId: null,
          },
        ],
        environment: "حديقة",
        composition: "متوازن",
        cameraFraming: "لقطة متوسطة",
      },
    ],
  };
}

function pagePrompt(selectedCharacterId: string) {
  return {
    schemaVersion: 1,
    pageNumber: 1,
    prompt: "وصف الصورة النهائي الآمن",
    negativeConstraints: [
      "لا كتابة",
      "لا شعارات",
      "لا أشخاص إضافيين",
      "لا عنف",
    ],
    referencePlan: [
      {
        characterRef: {
          characterId: selectedCharacterId,
          characterVersionId,
        },
        useSheetViews: ["face"],
      },
    ],
  };
}

function capacityPlan(
  participants: Array<{
    characterId: string;
    requestedAssetIds: string[];
    selectedAssetIds: string[];
  }>,
) {
  const bound = {
    providerId: "mock" as const,
    modelId: "mock-image-v1",
    settingsHash: hash,
    maxReferenceImages: 20,
    reliableCharacterCount: 20,
    participants,
    selectedAssetIds: participants.flatMap((item) => item.selectedAssetIds),
    reduced: false,
    participantExcess: false,
  };
  return {
    ...bound,
    bindingHash: creativeCapacityBindingHash(bound),
    confirmed: false,
  };
}

function settings(overrides: Record<string, unknown>): SettingsService {
  return {
    get: () => ({
      textProvider: "mock",
      imageProvider: "mock",
      geminiImageTier: "default",
      models: {
        codexText: "codex-model",
        geminiText: "gemini-text",
        geminiImage: "gemini-image",
        geminiImageEconomy: "gemini-economy",
      },
      ...overrides,
    }),
  } as SettingsService;
}
