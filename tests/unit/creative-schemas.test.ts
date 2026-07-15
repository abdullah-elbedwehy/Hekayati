import { describe, expect, it } from "vitest";

import {
  appearanceBindingSchema,
  characterSheetSchema,
  pageReviewSchema,
  pageSchema,
} from "../../src/domain/creative/schemas.js";

const ids = Array.from(
  { length: 30 },
  (_, index) => `01J${String(index + 1).padStart(23, "0")}`,
);
const at = "2026-07-14T00:00:00.000Z";

describe("creative schemas", () => {
  it("models base appearance without a fabricated look id", () => {
    expect(
      appearanceBindingSchema.parse({
        type: "base",
        lookId: null,
        lookVersionId: null,
      }),
    ).toEqual({ type: "base", lookId: null, lookVersionId: null });
    expect(() =>
      appearanceBindingSchema.parse({
        type: "base",
        lookId: ids[0],
        lookVersionId: ids[1],
      }),
    ).toThrow();
  });

  it("requires exact look identity and version for shared appearance", () => {
    expect(
      appearanceBindingSchema.parse({
        type: "shared_look",
        lookId: ids[0],
        lookVersionId: ids[1],
      }),
    ).toMatchObject({ type: "shared_look" });
    expect(() =>
      appearanceBindingSchema.parse({
        type: "shared_look",
        lookId: ids[0],
        lookVersionId: null,
      }),
    ).toThrow();
  });

  it("requires every sheet view and rejects unknown content", () => {
    const sheet = characterSheetSchema.parse(sheetFixture());
    expect(Object.keys(sheet.views)).toEqual([
      "face",
      "front",
      "threeQuarter",
      "fullBody",
      "mainOutfit",
    ]);
    expect(() =>
      characterSheetSchema.parse({ ...sheetFixture(), rawProviderBody: "no" }),
    ).toThrow();
  });

  it("keeps page state version-bound and locked-stale explicit", () => {
    const page = pageSchema.parse({
      id: ids[0],
      schemaVersion: 2,
      createdAt: at,
      updatedAt: at,
      revision: 2,
      projectId: ids[1],
      pageNumber: 7,
      storyPageIndex: 5,
      kind: "story",
      locked: true,
      reviewStatus: "approved",
      staleState: "locked_stale",
      staleReasons: ["IM-04"],
      currentTextVersionId: ids[2],
      currentPromptVersionId: ids[3],
      currentIllustrationVersionId: ids[4],
    });
    expect(page.staleState).toBe("locked_stale");
  });

  it("rejects a completed review with any missing required check", () => {
    const review = reviewFixture();
    expect(pageReviewSchema.parse(review).completed).toBe(true);
    expect(() =>
      pageReviewSchema.parse({
        ...review,
        checks: { ...review.checks, noInImageText: false },
      }),
    ).toThrow(/REVIEW_CHECKLIST_INCOMPLETE/);
  });
});

function sheetFixture() {
  return {
    id: ids[0],
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    projectId: ids[1],
    customerId: ids[2],
    familyId: ids[3],
    characterId: ids[4],
    characterVersionId: ids[5],
    appearance: { type: "base" as const, lookId: null, lookVersionId: null },
    characterName: "نور",
    views: {
      face: ids[6],
      front: ids[7],
      threeQuarter: ids[8],
      fullBody: ids[9],
      mainOutfit: ids[10],
    },
    referenceThumbnailAssetIds: [ids[11]],
    referenceLineage: {
      source: "photo_derived" as const,
      referencePhotoIds: [ids[12]],
    },
    pdfAssetId: ids[13],
    status: "ready" as const,
    priorSheetId: null,
    generationJobIds: ids.slice(14, 20),
    provenanceByView: {},
  };
}

function reviewFixture() {
  return {
    id: ids[0],
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    pageId: ids[1],
    pageRevision: 4,
    textVersionId: ids[2],
    illustrationVersionId: ids[3],
    checks: {
      identityMatchesSheet: true,
      outfitMatchesPlan: true,
      participantsExact: true,
      petAnatomySafe: true,
      ageAndRegisterAppropriate: true,
      noInImageText: true,
      artTextConsistent: true,
      noSexualizedChild: true,
      noGraphicViolence: true,
      noDangerousInstructions: true,
      noHumiliationOrPunishment: true,
      noHateOrStereotypes: true,
      noAdultThemes: true,
      noChildBlame: true,
      noExcessiveFear: true,
      noCopyrightCharacter: true,
      noLivingArtistImitation: true,
      noContactDetails: true,
      noCrossCustomerData: true,
    },
    notes: "تمت المراجعة",
    completed: true,
    recordedAt: at,
  };
}
