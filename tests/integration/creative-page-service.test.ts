import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { resolveDataPaths } from "../../src/config/paths.js";
import { AuthoringService } from "../../src/domain/authoring/index.js";
import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { CreativeInvalidationService } from "../../src/domain/creative/invalidation.js";
import { CreativePageService } from "../../src/domain/creative/pages.js";
import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import { LibraryService } from "../../src/domain/library/index.js";
import { LibraryRepositories } from "../../src/domain/library/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import type { Provenance } from "../../src/providers/contract.js";
import { seedCreativeProject } from "../helpers/creative-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-14T00:00:00.000Z";
const ids = Array.from(
  { length: 120 },
  (_, index) => `01J${String(index + 1).padStart(23, "0")}`,
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("creative page service", () => {
  it("creates the exact 16-page canonical map idempotently", async () => {
    const fixture = await harness();
    const first = fixture.pages.ensureProjectPages(ids[0], 16);
    const replay = fixture.pages.ensureProjectPages(ids[0], 16);
    expect(first).toHaveLength(16);
    expect(replay.map((page) => page.id)).toEqual(first.map((page) => page.id));
    expect(first.map(({ pageNumber, kind }) => ({ pageNumber, kind }))).toEqual(
      [
        { pageNumber: 1, kind: "title" },
        { pageNumber: 2, kind: "dedication" },
        ...Array.from({ length: 12 }, (_, index) => ({
          pageNumber: index + 3,
          kind: "story",
        })),
        { pageNumber: 15, kind: "ending1" },
        { pageNumber: 16, kind: "ending2" },
      ],
    );
    fixture.close();
  });

  it("regenerates one page without changing sibling heads", async () => {
    const fixture = await harness();
    const pages = fixture.pages.ensureProjectPages(ids[0], 16);
    const storyPages = pages.filter((page) => page.kind === "story");
    for (const [index, page] of storyPages.entries()) {
      fixture.pages.seedGeneratedPage({
        pageId: page.id,
        expectedRevision: page.revision,
        sceneVersionId: ids[40 + index],
        narrative: `صفحة ${index + 1}`,
        prompt: prompt(index + 1),
        illustrationAssetId: ids[70 + index],
        provenance,
      });
    }
    const before = fixture.pages.listProjectPages(ids[0]).map((page) => ({
      id: page.id,
      head: page.currentIllustrationVersionId,
    }));
    const page7 = fixture.pages
      .listProjectPages(ids[0])
      .find((page) => page.pageNumber === 7)!;
    fixture.pages.appendIllustration({
      pageId: page7.id,
      expectedRevision: page7.revision,
      promptVersionId: page7.currentPromptVersionId!,
      assetId: ids[99],
      inputSnapshot: { promptVersion: page7.currentPromptVersionId! },
      provenance,
    });
    const after = fixture.pages.listProjectPages(ids[0]).map((page) => ({
      id: page.id,
      head: page.currentIllustrationVersionId,
    }));
    expect(after.filter((item) => item.id !== page7.id)).toEqual(
      before.filter((item) => item.id !== page7.id),
    );
    expect(after.find((item) => item.id === page7.id)?.head).not.toBe(
      before.find((item) => item.id === page7.id)?.head,
    );
    fixture.close();
  });

  it("requires a current complete review before locking", async () => {
    const fixture = await harness();
    const page = fixture.pages.ensureProjectPages(ids[0], 16)[2];
    const generated = fixture.pages.seedGeneratedPage({
      pageId: page.id,
      expectedRevision: page.revision,
      sceneVersionId: ids[40],
      narrative: "حكاية بسيطة",
      prompt: prompt(1),
      illustrationAssetId: ids[70],
      provenance,
    }).page;
    expect(() =>
      fixture.pages.lockPage(generated.id, generated.revision),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_PAGE_NOT_REVIEWED" }),
    );
    const review = fixture.pages.recordReview({
      pageId: generated.id,
      expectedRevision: generated.revision,
      textVersionId: generated.currentTextVersionId!,
      illustrationVersionId: generated.currentIllustrationVersionId!,
      checks: allChecks(),
      notes: "تم",
    });
    const locked = fixture.pages.lockPage(review.page.id, review.page.revision);
    expect(locked).toMatchObject({ locked: true, reviewStatus: "approved" });
    fixture.close();
  });

  it("freezes locked content but permits locked-stale flagging", async () => {
    const fixture = await harness();
    const page = readyLockedPage(fixture);
    const head = page.currentIllustrationVersionId;
    expect(() =>
      fixture.pages.appendIllustration({
        pageId: page.id,
        expectedRevision: page.revision,
        promptVersionId: page.currentPromptVersionId!,
        assetId: ids[99],
        inputSnapshot: { promptVersion: page.currentPromptVersionId! },
        provenance,
      }),
    ).toThrowError(expect.objectContaining({ code: "CREATIVE_PAGE_LOCKED" }));
    const stale = fixture.pages.markStale(page.id, "IM-04");
    expect(stale).toMatchObject({
      staleState: "locked_stale",
      currentIllustrationVersionId: head,
    });
    fixture.close();
  });

  it("rejects stale review tuples and preserves all illustration history", async () => {
    const fixture = await harness();
    const page = fixture.pages.ensureProjectPages(ids[0], 16)[2];
    const generated = fixture.pages.seedGeneratedPage({
      pageId: page.id,
      expectedRevision: page.revision,
      sceneVersionId: ids[40],
      narrative: "حكاية بسيطة",
      prompt: prompt(1),
      illustrationAssetId: ids[70],
      provenance,
    }).page;
    const oldHead = generated.currentIllustrationVersionId!;
    const regenerated = fixture.pages.appendIllustration({
      pageId: generated.id,
      expectedRevision: generated.revision,
      promptVersionId: generated.currentPromptVersionId!,
      assetId: ids[71],
      inputSnapshot: { promptVersion: generated.currentPromptVersionId! },
      provenance,
    }).page;
    expect(() =>
      fixture.pages.recordReview({
        pageId: regenerated.id,
        expectedRevision: regenerated.revision,
        textVersionId: regenerated.currentTextVersionId!,
        illustrationVersionId: oldHead,
        checks: allChecks(),
        notes: "قديم",
      }),
    ).toThrowError(expect.objectContaining({ code: "CREATIVE_REVIEW_STALE" }));
    expect(fixture.pages.illustrationHistory(page.id)).toHaveLength(2);
    fixture.close();
  });

  it("emits one audited matrix event for every page operation", async () => {
    const fixture = await richHarness();
    const seeded = seedRichPage(fixture);
    const originalText = seeded.currentTextVersionId!;
    const originalIllustration = seeded.currentIllustrationVersionId!;

    const manual = expectOneChange(fixture, "IM-07", () =>
      fixture.pages.appendManualText({
        pageId: seeded.id,
        expectedRevision: seeded.revision,
        narrative: "كان البطل مستعدًا!",
        dialogue: [],
      }),
    );
    expect(manual.page.currentIllustrationVersionId).toBe(originalIllustration);
    expect(manual.text.sceneVersionId).not.toBe(
      fixture.pages.getTextVersion(originalText).sceneVersionId,
    );
    expect(
      fixture.authoring.getProjectWorkspace(
        fixture.seed.scope,
        fixture.seed.projectId,
      ).scenes[0]?.version.id,
    ).toBe(manual.text.sceneVersionId);

    const revertedText = expectOneChange(fixture, "IM-07", () =>
      fixture.pages.revertText({
        pageId: manual.page.id,
        expectedRevision: manual.page.revision,
        targetVersionId: originalText,
      }),
    );
    expect(revertedText.page.currentIllustrationVersionId).toBe(
      originalIllustration,
    );
    expect(revertedText.text.sceneVersionId).not.toBe(
      fixture.pages.getTextVersion(originalText).sceneVersionId,
    );
    expect(fixture.pages.textHistory(seeded.id)).toHaveLength(3);

    const regenerated = expectOneChange(fixture, "IM-10", () =>
      fixture.pages.appendIllustration({
        pageId: revertedText.page.id,
        expectedRevision: revertedText.page.revision,
        promptVersionId: revertedText.page.currentPromptVersionId!,
        assetId: ulid(),
        inputSnapshot: {
          promptVersion: revertedText.page.currentPromptVersionId!,
        },
        provenance,
      }),
    );
    expect(regenerated.page.currentTextVersionId).toBe(
      revertedText.page.currentTextVersionId,
    );

    const revertedIllustration = expectOneChange(fixture, "IM-10", () =>
      fixture.pages.revertIllustration({
        pageId: regenerated.page.id,
        expectedRevision: regenerated.page.revision,
        targetVersionId: originalIllustration,
      }),
    );
    expect(revertedIllustration.page.currentTextVersionId).toBe(
      regenerated.page.currentTextVersionId,
    );
    expect(fixture.pages.illustrationHistory(seeded.id)).toHaveLength(3);

    const expectedRevision = revertedIllustration.page.revision;
    const request = expectOneChange(fixture, "IM-11", () =>
      fixture.pages.requestLayoutRecalculation({
        pageId: revertedIllustration.page.id,
        expectedRevision,
        reason: "إعادة حساب موضع النص فقط",
      }),
    );
    expect(request.state).toBe("pending");
    expect(fixture.pages.getPage(seeded.id)).toMatchObject({
      revision: expectedRevision + 1,
      currentLayoutVersionId: null,
    });
    expect(() =>
      fixture.pages.requestLayoutRecalculation({
        pageId: seeded.id,
        expectedRevision,
        reason: "طلب مكرر",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_REVISION_CONFLICT" }),
    );

    const current = fixture.pages.getPage(seeded.id);
    const reviewed = fixture.pages.recordReview({
      pageId: current.id,
      expectedRevision: current.revision,
      textVersionId: current.currentTextVersionId!,
      illustrationVersionId: current.currentIllustrationVersionId!,
      checks: allChecks(),
      notes: "تم",
    }).page;
    const locked = fixture.pages.lockPage(reviewed.id, reviewed.revision);
    expect(() =>
      fixture.pages.requestLayoutRecalculation({
        pageId: locked.id,
        expectedRevision: locked.revision,
        reason: "ممنوع أثناء القفل",
      }),
    ).toThrowError(expect.objectContaining({ code: "CREATIVE_PAGE_LOCKED" }));
    fixture.close();
  });

  it("rolls back illustration lineage when event persistence fails", async () => {
    const fixture = await richHarness();
    const seeded = seedRichPage(fixture);
    const beforeBookVersion = fixture.repositories.projects.get(
      fixture.seed.projectId,
    )!.bookVersion;
    const beforeHistory = fixture.pages.illustrationHistory(seeded.id);
    const beforePage = fixture.pages.getPage(seeded.id);
    const idsForFailure = [ulid(), "not-an-event-id"];
    const failing = new CreativePageService(fixture.store, {
      idFactory: () => idsForFailure.shift()!,
    });

    expect(() =>
      failing.appendIllustration({
        pageId: seeded.id,
        expectedRevision: seeded.revision,
        promptVersionId: seeded.currentPromptVersionId!,
        assetId: ulid(),
        inputSnapshot: { promptVersion: seeded.currentPromptVersionId! },
        provenance,
      }),
    ).toThrow();
    expect(fixture.pages.getPage(seeded.id)).toEqual(beforePage);
    expect(fixture.pages.illustrationHistory(seeded.id)).toEqual(beforeHistory);
    expect(
      fixture.repositories.projects.get(fixture.seed.projectId)!.bookVersion,
    ).toBe(beforeBookVersion);
    fixture.close();
  });

  it("rejects missing scope, page-map drift, and stale generation bindings", async () => {
    const fixture = await harness();
    expect(() => fixture.pages.ensureProjectPages(ids[119], 16)).toThrowError(
      expect.objectContaining({ code: "CREATIVE_ENTITY_NOT_FOUND" }),
    );

    const created = fixture.pages.ensureProjectPages(ids[0], 16);
    expect(() => fixture.pages.ensureProjectPages(ids[0], 24)).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    expect(() =>
      fixture.pages.seedGeneratedPage({
        pageId: created[0].id,
        expectedRevision: created[0].revision,
        sceneVersionId: ids[40],
        narrative: "صفحة عنوان",
        prompt: prompt(1),
        illustrationAssetId: ids[70],
        provenance,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );

    const story = created[2];
    expect(() =>
      fixture.pages.seedGeneratedPage({
        pageId: story.id,
        expectedRevision: story.revision + 1,
        sceneVersionId: ids[40],
        narrative: "نسخة قديمة",
        prompt: prompt(1),
        illustrationAssetId: ids[70],
        provenance,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_REVISION_CONFLICT" }),
    );
    expect(() =>
      fixture.pages.seedGeneratedPage({
        pageId: story.id,
        expectedRevision: story.revision,
        sceneVersionId: ids[40],
        narrative: "ترقيم خاطئ",
        prompt: prompt(2),
        illustrationAssetId: ids[70],
        provenance,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );

    const generated = fixture.pages.seedGeneratedPage({
      pageId: story.id,
      expectedRevision: story.revision,
      sceneVersionId: ids[40],
      narrative: "حكاية سليمة",
      prompt: prompt(1),
      illustrationAssetId: ids[70],
      provenance,
    }).page;
    expect(() =>
      fixture.pages.seedGeneratedPage({
        pageId: generated.id,
        expectedRevision: generated.revision,
        sceneVersionId: ids[40],
        narrative: "تكرار",
        prompt: prompt(1),
        illustrationAssetId: ids[71],
        provenance,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    expect(() =>
      fixture.pages.appendIllustration({
        pageId: generated.id,
        expectedRevision: generated.revision,
        promptVersionId: ids[119],
        assetId: ids[71],
        inputSnapshot: {},
        provenance,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    fixture.close();
  });

  it("rejects incomplete prompt, text, illustration, layout, and review lineage", async () => {
    const fixture = await harness();
    const storyPages = fixture.pages
      .ensureProjectPages(ids[0], 16)
      .filter((page) => page.kind === "story");
    const empty = storyPages[0];
    expect(() =>
      fixture.pages.appendPrompt({
        pageId: empty.id,
        expectedRevision: empty.revision,
        sceneVersionId: ids[40],
        output: prompt(2),
        styleId: "modern_cartoon",
        jobId: ids[80],
        provenance,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    expect(() =>
      fixture.pages.appendPrompt({
        pageId: empty.id,
        expectedRevision: empty.revision,
        sceneVersionId: ids[40],
        output: prompt(1),
        styleId: "modern_cartoon",
        jobId: ids[80],
        provenance,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    expect(() =>
      fixture.pages.appendManualText({
        pageId: empty.id,
        expectedRevision: empty.revision,
        narrative: "لا يوجد أصل",
        dialogue: [],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" }),
    );
    expect(() => fixture.pages.getPromptVersion(ids[119])).toThrowError(
      expect.objectContaining({ code: "CREATIVE_ENTITY_NOT_FOUND" }),
    );
    expect(() => fixture.pages.getTextVersion(ids[119])).toThrowError(
      expect.objectContaining({ code: "CREATIVE_ENTITY_NOT_FOUND" }),
    );
    expect(() => fixture.pages.getIllustrationVersion(ids[119])).toThrowError(
      expect.objectContaining({ code: "CREATIVE_ENTITY_NOT_FOUND" }),
    );

    const first = seedSimplePage(fixture, storyPages[0], 1, 40, 70);
    const second = seedSimplePage(fixture, storyPages[1], 2, 41, 71);
    expect(() =>
      fixture.pages.revertText({
        pageId: first.id,
        expectedRevision: first.revision,
        targetVersionId: second.currentTextVersionId!,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    expect(() =>
      fixture.pages.revertIllustration({
        pageId: first.id,
        expectedRevision: first.revision,
        targetVersionId: second.currentIllustrationVersionId!,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );

    expect(() =>
      fixture.pages.requestLayoutRecalculation({
        pageId: storyPages[2].id,
        expectedRevision: storyPages[2].revision,
        reason: "لا نص ولا صورة",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" }),
    );
    const stale = fixture.pages.markStale(first.id, "IM-04");
    expect(() =>
      fixture.pages.requestLayoutRecalculation({
        pageId: stale.id,
        expectedRevision: stale.revision,
        reason: "مدخل قديم",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" }),
    );
    expect(() =>
      fixture.pages.recordReview({
        pageId: stale.id,
        expectedRevision: stale.revision,
        textVersionId: stale.currentTextVersionId!,
        illustrationVersionId: stale.currentIllustrationVersionId!,
        checks: allChecks(),
        notes: "مراجعة مدخل قديم",
      }),
    ).toThrowError(expect.objectContaining({ code: "CREATIVE_PAGE_STALE" }));
    fixture.close();
  });

  it("keeps lock, stale, unlock, and review flags idempotent", async () => {
    const fixture = await harness();
    const firstLocked = readyLockedPage(fixture, 2);
    expect(
      fixture.pages.lockPage(firstLocked.id, firstLocked.revision),
    ).toEqual(firstLocked);
    const lockedStale = fixture.pages.markStale(firstLocked.id, "IM-04");
    const unlockedStale = fixture.pages.unlockPage(
      lockedStale.id,
      lockedStale.revision,
    );
    expect(unlockedStale).toMatchObject({ locked: false, staleState: "stale" });
    expect(() =>
      fixture.pages.recordReview({
        pageId: unlockedStale.id,
        expectedRevision: unlockedStale.revision,
        textVersionId: unlockedStale.currentTextVersionId!,
        illustrationVersionId: unlockedStale.currentIllustrationVersionId!,
        checks: allChecks(),
        notes: "قديم",
      }),
    ).toThrowError(expect.objectContaining({ code: "CREATIVE_PAGE_STALE" }));

    const secondLocked = readyLockedPage(fixture, 3);
    expect(
      fixture.pages.unlockPage(secondLocked.id, secondLocked.revision),
    ).toMatchObject({ locked: false, staleState: "current" });
    const untouched = fixture.pages.ensureProjectPages(ids[0], 16)[4];
    expect(fixture.pages.unlockPage(untouched.id, untouched.revision)).toEqual(
      untouched,
    );
    const stale = fixture.pages.markStale(untouched.id, "IM-01");
    expect(fixture.pages.markStale(stale.id, "IM-01")).toEqual(stale);
    const flagged = fixture.pages.flagForReview(stale.id);
    expect(fixture.pages.flagForReview(flagged.id)).toEqual(flagged);
    fixture.close();
  });
});

async function harness() {
  const temp = await temporaryDirectory("hekayati-creative-pages-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "creative.db"));
  const authoring = new AuthoringRepositories(store);
  authoring.projects.insert({
    id: ids[0],
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    customerId: ids[1],
    familyId: ids[2],
    status: "draft",
    priority: 0,
    paused: false,
    currentVersionId: ids[3],
    bookVersion: 1,
    printerProfileId: null,
  });
  let cursor = 4;
  return {
    pages: new CreativePageService(store, {
      now: () => at,
      idFactory: () => ids[cursor++],
    }),
    close: () => store.close(),
  };
}

async function richHarness() {
  const temp = await temporaryDirectory("hekayati-rich-pages-");
  cleanups.push(temp.cleanup);
  const seed = await seedCreativeProject(temp.path, "-page-events");
  const store = new DocumentStore(resolveDataPaths(temp.path).database);
  const library = new LibraryService(store);
  return {
    seed,
    store,
    authoring: new AuthoringService(store, library),
    repositories: new AuthoringRepositories(store),
    libraryRepositories: new LibraryRepositories(store),
    creative: new CreativeRepositories(store),
    invalidation: new CreativeInvalidationService(store),
    pages: new CreativePageService(store),
    close: () => store.close(),
  };
}

function seedRichPage(fixture: Awaited<ReturnType<typeof richHarness>>) {
  const initial = fixture.authoring.getProjectWorkspace(
    fixture.seed.scope,
    fixture.seed.projectId,
  );
  const first = initial.scenes[0];
  const authored = fixture.authoring.updateScene(
    fixture.seed.scope,
    fixture.seed.projectId,
    first.scene.storyPageIndex,
    {
      expectedStoryVersionId: initial.storyVersion.id,
      expectedSceneVersionId: first.version.id,
      content: completeSceneContent(fixture.seed.characterId),
    },
  );
  const page = fixture.pages.ensureProjectPages(fixture.seed.projectId, 16)[2];
  return fixture.pages.seedGeneratedPage({
    pageId: page.id,
    expectedRevision: page.revision,
    sceneVersionId: authored.scenes[0].version.id,
    narrative: "كان البطل مستعدًا.",
    prompt: prompt(1),
    illustrationAssetId: ulid(),
    provenance,
  }).page;
}

function expectOneChange<T>(
  fixture: Awaited<ReturnType<typeof richHarness>>,
  matrixRow: "IM-07" | "IM-10" | "IM-11",
  operation: () => T,
): T {
  const beforeEvents = new Set(
    fixture.libraryRepositories.changeEvents.list().map((event) => event.id),
  );
  const beforeAudits = fixture.creative.invalidationAudits.list().length;
  const beforeBookVersion = fixture.repositories.projects.get(
    fixture.seed.projectId,
  )!.bookVersion;
  const result = operation();
  const created = fixture.libraryRepositories.changeEvents
    .list()
    .filter((event) => !beforeEvents.has(event.id));
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ matrixRow });
  expect(
    fixture.libraryRepositories.invalidationReceipts.get(created[0].id),
  ).not.toBeNull();
  expect(fixture.creative.invalidationAudits.list()).toHaveLength(
    beforeAudits + 1,
  );
  expect(
    fixture.repositories.projects.get(fixture.seed.projectId)!.bookVersion,
  ).toBe(beforeBookVersion + 1);
  fixture.invalidation.consume(created[0].id);
  expect(
    fixture.repositories.projects.get(fixture.seed.projectId)!.bookVersion,
  ).toBe(beforeBookVersion + 1);
  return result;
}

function completeSceneContent(characterId: string) {
  return {
    purpose: "لحظة واضحة",
    description: "مشهد آمن ومفهوم",
    documentSegments: [
      {
        type: "mention" as const,
        characterId,
        props: {
          action: "بيتحرك بثقة",
          emotion: "متحمس",
          position: null,
          framing: null,
          lookId: null,
          heldObject: null,
          gazeTarget: null,
          speaks: false,
          dialogue: null,
        },
      },
    ],
    environment: "مكان خيالي",
    timeOfDay: "نهار",
    composition: "واسع",
    cameraFraming: "متوسط",
    narrativeText: "كان البطل مستعدًا.",
    dialogue: [],
    twoImageMoment: false,
  };
}

function readyLockedPage(
  fixture: Awaited<ReturnType<typeof harness>>,
  pageIndex = 2,
) {
  const page = fixture.pages.ensureProjectPages(ids[0], 16)[pageIndex];
  const generated = fixture.pages.seedGeneratedPage({
    pageId: page.id,
    expectedRevision: page.revision,
    sceneVersionId: ids[40],
    narrative: "حكاية بسيطة",
    prompt: prompt(page.storyPageIndex!),
    illustrationAssetId: ids[70],
    provenance,
  }).page;
  const reviewed = fixture.pages.recordReview({
    pageId: generated.id,
    expectedRevision: generated.revision,
    textVersionId: generated.currentTextVersionId!,
    illustrationVersionId: generated.currentIllustrationVersionId!,
    checks: allChecks(),
    notes: "تم",
  }).page;
  return fixture.pages.lockPage(reviewed.id, reviewed.revision);
}

function seedSimplePage(
  fixture: Awaited<ReturnType<typeof harness>>,
  page: ReturnType<CreativePageService["getPage"]>,
  storyPageNumber: number,
  sceneIdIndex: number,
  assetIdIndex: number,
) {
  return fixture.pages.seedGeneratedPage({
    pageId: page.id,
    expectedRevision: page.revision,
    sceneVersionId: ids[sceneIdIndex],
    narrative: `صفحة ${storyPageNumber}`,
    prompt: prompt(storyPageNumber),
    illustrationAssetId: ids[assetIdIndex],
    provenance,
  }).page;
}

function prompt(pageNumber: number) {
  return {
    schemaVersion: 1 as const,
    pageNumber,
    prompt: `مشهد أصلي ${pageNumber}`,
    negativeConstraints: [
      "no_extra_people",
      "no_story_text",
      "no_onomatopoeia",
      "no_photoreal_face",
    ],
    referencePlan: [],
  };
}

function allChecks() {
  return {
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
}

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
