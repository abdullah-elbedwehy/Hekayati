import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { CreativeInvalidationService } from "../../src/domain/creative/invalidation.js";
import { CreativePageService } from "../../src/domain/creative/pages.js";
import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import { LibraryRepositories } from "../../src/domain/library/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import type { Provenance } from "../../src/providers/contract.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-14T00:00:00.000Z";
const ids = Array.from(
  { length: 180 },
  (_, index) => `01J${String(index + 1).padStart(23, "0")}`,
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("creative invalidation service", () => {
  it("supersedes approval, flags locked page, bumps once, and replays idempotently", async () => {
    const fixture = await harness();
    const page = fixture.pages.ensureProjectPages(ids[0], 16)[2];
    const generated = fixture.pages.seedGeneratedPage({
      pageId: page.id,
      expectedRevision: page.revision,
      sceneVersionId: ids[40],
      narrative: "حكاية",
      prompt: prompt,
      illustrationAssetId: ids[70],
      provenance,
    }).page;
    const withSnapshot = fixture.pages.appendIllustration({
      pageId: generated.id,
      expectedRevision: generated.revision,
      promptVersionId: generated.currentPromptVersionId!,
      assetId: ids[71],
      inputSnapshot: {
        promptVersion: generated.currentPromptVersionId!,
        characterVersion: ids[21],
      },
      provenance,
    }).page;
    const reviewed = fixture.pages.recordReview({
      pageId: withSnapshot.id,
      expectedRevision: withSnapshot.revision,
      textVersionId: withSnapshot.currentTextVersionId!,
      illustrationVersionId: withSnapshot.currentIllustrationVersionId!,
      checks: allChecks,
      notes: "تم",
    }).page;
    const locked = fixture.pages.lockPage(reviewed.id, reviewed.revision);
    seedApprovedSheet(fixture.creative);
    const event = fixture.invalidation.appendEvent({
      id: ids[120],
      entity: "character",
      entityId: ids[20],
      fromVersionId: ids[21],
      toVersionId: ids[22],
      changeType: "permanent_appearance",
      matrixRow: "IM-01",
      changedFields: ["hair"],
      correlationId: ids[121],
    });
    const before = fixture.authoring.projects.get(ids[0])!.bookVersion;
    const beforeLocked = fixture.pages.getPage(page.id);
    const beforeOtherPages = fixture.pages
      .listProjectPages(ids[0])
      .filter((item) => item.id !== page.id);
    const head = locked.currentIllustrationVersionId;
    const affected = fixture.invalidation.affectedItems(event.id);
    const audit = affected.audit;
    const replay = fixture.invalidation.consume(event.id);

    expect(replay.id).toBe(audit.id);
    expect(affected.actions).toEqual([
      {
        id: ids[90],
        effect: "stale",
        actions: ["regenerate", "keep_stale"],
      },
      {
        id: ids[91],
        effect: "stale",
        actions: ["regenerate", "keep_stale"],
      },
      {
        id: page.id,
        effect: "locked_stale",
        actions: ["keep_stale", "unlock_and_edit"],
      },
    ]);
    expect(audit).toMatchObject({
      eventId: event.id,
      matrixRow: "IM-01",
      affectedIds: [page.id, ids[90], ids[91]],
      bookVersionProjectIds: [ids[0]],
    });
    expect(fixture.creative.sheets.get(ids[90])).toMatchObject({
      status: "approved_superseded",
      revision: 1,
    });
    expect(fixture.creative.approvals.get(ids[91])).toMatchObject({
      state: "superseded",
      invalidatedByEventId: event.id,
      revision: 1,
    });
    expect(fixture.pages.getPage(page.id)).toMatchObject({
      staleState: "locked_stale",
      staleReasons: ["IM-01"],
      currentIllustrationVersionId: head,
      revision: beforeLocked.revision + 1,
    });
    expect(
      fixture.pages
        .listProjectPages(ids[0])
        .filter((item) => item.id !== page.id),
    ).toEqual(beforeOtherPages);
    expect(fixture.authoring.projects.get(ids[0])!.bookVersion).toBe(
      before + 1,
    );
    expect(
      fixture.creative.invalidationAudits.queryByField("eventId", event.id),
    ).toEqual([audit]);
    fixture.close();
  });

  it("limits a direct IM-07 change to the named page and bumps its project exactly once", async () => {
    const fixture = await harness();
    const pages = fixture.pages.ensureProjectPages(ids[0], 16);
    const first = seedPage(fixture, pages[2], ids[40], ids[70]);
    const second = seedPage(fixture, pages[3], ids[41], ids[71]);
    const firstWithLayout = fixture.creative.pages.update({
      ...first,
      currentLayoutVersionId: ids[72],
      revision: first.revision + 1,
    });
    const secondWithLayout = fixture.creative.pages.update({
      ...second,
      currentLayoutVersionId: ids[73],
      revision: second.revision + 1,
    });
    const event = fixture.invalidation.appendEvent({
      id: ids[120],
      entity: "narrative_text",
      entityId: firstWithLayout.id,
      fromVersionId: firstWithLayout.currentTextVersionId,
      toVersionId: ids[74],
      changeType: "narrative_text",
      matrixRow: "IM-07",
      changedFields: ["narrative"],
      correlationId: ids[121],
    });
    const beforeVersion = fixture.authoring.projects.get(ids[0])!.bookVersion;
    const affected = fixture.invalidation.affectedItems(event.id);

    expect(affected.actions).toEqual([
      {
        id: firstWithLayout.id,
        effect: "stale",
        actions: ["regenerate", "keep_stale"],
      },
    ]);
    expect(affected.audit).toMatchObject({
      eventId: event.id,
      matrixRow: "IM-07",
      affectedIds: [firstWithLayout.id],
      bookVersionProjectIds: [ids[0]],
    });
    expect(fixture.pages.getPage(firstWithLayout.id)).toMatchObject({
      revision: firstWithLayout.revision + 1,
      staleState: "stale",
      staleReasons: ["IM-07"],
      currentLayoutVersionId: ids[72],
    });
    expect(fixture.pages.getPage(secondWithLayout.id)).toEqual(
      secondWithLayout,
    );
    expect(fixture.authoring.projects.get(ids[0])!.bookVersion).toBe(
      beforeVersion + 1,
    );

    const afterFirstConsume = fixture.pages.getPage(firstWithLayout.id);
    expect(fixture.invalidation.consume(event.id)).toEqual(affected.audit);
    expect(fixture.pages.getPage(firstWithLayout.id)).toEqual(
      afterFirstConsume,
    );
    expect(fixture.authoring.projects.get(ids[0])!.bookVersion).toBe(
      beforeVersion + 1,
    );
    fixture.close();
  });

  it("records IM-21 without changing any pinned artifact or book version", async () => {
    const fixture = await harness();
    const pages = fixture.pages.ensureProjectPages(ids[0], 16);
    seedApprovedSheet(fixture.creative);
    const beforePages = structuredClone(pages);
    const beforeSheet = structuredClone(fixture.creative.sheets.get(ids[90]));
    const beforeVersion = fixture.authoring.projects.get(ids[0])!.bookVersion;
    const event = fixture.invalidation.appendEvent({
      id: ids[120],
      entity: "library_visibility",
      entityId: ids[20],
      fromVersionId: null,
      toVersionId: null,
      changeType: "archive_restore",
      matrixRow: "IM-21",
      changedFields: ["status"],
      correlationId: ids[121],
    });
    const audit = fixture.invalidation.consume(event.id);
    expect(audit.affectedIds).toEqual([]);
    expect(fixture.pages.listProjectPages(ids[0])).toEqual(beforePages);
    expect(fixture.creative.sheets.get(ids[90])).toEqual(beforeSheet);
    expect(fixture.authoring.projects.get(ids[0])!.bookVersion).toBe(
      beforeVersion,
    );
    fixture.close();
  });

  it("authorizes a zero-artifact visibility event before writing its receipt", async () => {
    const fixture = await harness();
    const event = fixture.invalidation.appendEvent({
      id: ids[120],
      entity: "library_visibility",
      entityId: ids[20],
      fromVersionId: null,
      toVersionId: null,
      changeType: "archive_restore",
      matrixRow: "IM-21",
      changedFields: ["status"],
      correlationId: ids[121],
    });
    expect(() =>
      fixture.invalidation.affectedItemsForFamily(
        { customerId: ids[170], familyId: ids[171] },
        event.id,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CREATIVE_SCOPE_MISMATCH",
        statusCode: 403,
      }),
    );
    expect(fixture.library.invalidationReceipts.get(event.id)).toBeNull();
    expect(fixture.creative.invalidationAudits.list()).toHaveLength(0);
    const owner = fixture.invalidation.affectedItemsForFamily(
      { customerId: ids[1], familyId: ids[2] },
      event.id,
    );
    expect(owner).toMatchObject({
      event: { id: event.id, matrixRow: "IM-21" },
      affected: [],
    });
    const replay = fixture.invalidation.affectedItemsForFamily(
      { customerId: ids[1], familyId: ids[2] },
      event.id,
    );
    expect(replay.audit.id).toBe(owner.audit.id);
    expect(fixture.library.invalidationReceipts.get(event.id)).not.toBeNull();
    fixture.close();
  });

  it.each(["receipt", "audit"] as const)(
    "rejects replay when the persisted %s no longer matches its counterpart",
    async (tamperedRecord) => {
      const fixture = await harness();
      const event = fixture.invalidation.appendEvent({
        id: ids[120],
        entity: "library_visibility",
        entityId: ids[20],
        fromVersionId: null,
        toVersionId: null,
        changeType: "archive_restore",
        matrixRow: "IM-21",
        changedFields: ["status"],
        correlationId: ids[121],
      });
      const audit = fixture.invalidation.consume(event.id);
      const receipt = fixture.library.invalidationReceipts.get(event.id)!;
      const badHash = "a".repeat(64);

      if (tamperedRecord === "receipt") {
        fixture.library.invalidationReceipts.update({
          ...receipt,
          consequenceHash: badHash,
        });
      } else {
        fixture.creative.invalidationAudits.update({
          ...audit,
          consequenceHash: badHash,
        });
      }

      expect(() => fixture.invalidation.consume(event.id)).toThrowError(
        expect.objectContaining({
          code: "CREATIVE_INVALIDATION_CONFLICT",
          statusCode: 409,
        }),
      );
      expect(
        fixture.creative.invalidationAudits.queryByField("eventId", event.id),
      ).toHaveLength(1);
      expect(fixture.library.invalidationReceipts.list()).toHaveLength(1);
      fixture.close();
    },
  );
});

async function harness() {
  const temp = await temporaryDirectory("hekayati-invalidation-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "creative.db"));
  const library = new LibraryRepositories(store);
  seedLibraryScope(library);
  const authoring = new AuthoringRepositories(store);
  authoring.projects.insert({
    id: ids[0],
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    customerId: ids[1],
    familyId: ids[2],
    status: "internal_review",
    priority: 0,
    paused: false,
    currentVersionId: ids[3],
    bookVersion: 1,
    printerProfileId: null,
  });
  let cursor = 4;
  const options = {
    now: () => at,
    idFactory: () => ids[cursor++],
  };
  return {
    store,
    library,
    authoring,
    creative: new CreativeRepositories(store),
    pages: new CreativePageService(store, options),
    invalidation: new CreativeInvalidationService(store, options),
    close: () => store.close(),
  };
}

function seedPage(
  fixture: Awaited<ReturnType<typeof harness>>,
  page: ReturnType<CreativePageService["getPage"]>,
  sceneVersionId: string,
  illustrationAssetId: string,
) {
  return fixture.pages.seedGeneratedPage({
    pageId: page.id,
    expectedRevision: page.revision,
    sceneVersionId,
    narrative: "حكاية اصطناعية",
    prompt: { ...prompt, pageNumber: page.storyPageIndex! },
    illustrationAssetId,
    provenance,
  }).page;
}

function seedLibraryScope(repositories: LibraryRepositories): void {
  for (const [customerId, familyId, characterId, name] of [
    [ids[1], ids[2], ids[20], "مالك"],
    [ids[170], ids[171], ids[172], "أجنبي"],
  ] as const) {
    repositories.customers.insert(
      {
        id: customerId,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        name,
        whatsapp: "",
        notes: "synthetic",
        consent: null,
        status: "active",
      },
      "DUPLICATE_ENTITY_ID",
    );
    repositories.families.insert(
      {
        id: familyId,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        customerId,
        name: `عائلة ${name}`,
        anchorCharacterId: characterId,
        status: "active",
      },
      "DUPLICATE_ENTITY_ID",
    );
    repositories.characters.insert(
      {
        id: characterId,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        familyId,
        status: "active",
        currentVersionId: ids[21],
      },
      "DUPLICATE_ENTITY_ID",
    );
  }
}

function seedApprovedSheet(repositories: CreativeRepositories): void {
  repositories.sheets.insert({
    id: ids[90],
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    projectId: ids[0],
    customerId: ids[1],
    familyId: ids[2],
    characterId: ids[20],
    characterVersionId: ids[21],
    appearance: { type: "base", lookId: null, lookVersionId: null },
    characterName: "نور",
    views: {
      face: ids[80],
      front: ids[81],
      threeQuarter: ids[82],
      fullBody: ids[83],
      mainOutfit: ids[84],
    },
    referenceThumbnailAssetIds: [],
    referenceLineage: {
      source: "description_only",
      referencePhotoIds: [],
    },
    pdfAssetId: ids[85],
    status: "approved",
    priorSheetId: null,
    generationJobIds: ids.slice(100, 106),
    provenanceByView: {},
  });
  repositories.approvals.insert({
    id: ids[91],
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    projectId: ids[0],
    characterId: ids[20],
    characterVersionId: ids[21],
    sheetId: ids[90],
    state: "approved",
    notes: "موافق",
    recordedAt: at,
    invalidatedByEventId: null,
  });
}

const prompt = {
  schemaVersion: 1 as const,
  pageNumber: 1,
  prompt: "مشهد أصلي",
  negativeConstraints: [
    "no_extra_people",
    "no_story_text",
    "no_onomatopoeia",
    "no_photoreal_face",
  ],
  referencePlan: [],
};

const provenance: Provenance = {
  provider: "mock",
  modelId: "mock-image-v1",
  at,
  inputVersionRefs: {},
  promptVersion: "mock-v1",
  referenceAssetIds: [],
  attempt: 1,
  settingsSnapshotHash: "f".repeat(64),
};

const allChecks = {
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
};
