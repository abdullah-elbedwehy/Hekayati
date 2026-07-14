import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import {
  assertCrossFamilyDraftReady,
  AuthoringService,
  installSeedTemplates,
  mapCrossFamilyRole,
  type ProjectInput,
} from "../../src/domain/authoring/index.js";
import {
  LibraryService,
  characterProfileSchema,
  type CharacterProfile,
} from "../../src/domain/library/index.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("immutable project authoring", () => {
  it("creates a family-scoped 16-page project with pinned versions and restart-safe slots", async () => {
    const fixture = await authoringFixture();
    const seeded = seedFamily(fixture.library);
    const friend = fixture.library.createCharacter(seeded.scope, {
      profile: profile({ name: "أحمد", relationship: { type: "friend" } }),
    });
    const look = fixture.library.createLook(seeded.scope, {
      characterId: friend.character.id,
      content: {
        name: "بدلة فضاء",
        clothing: "بدلة زرقاء",
        appearanceOverrides: {},
        referencePhotoIds: [],
      },
    });

    const created = fixture.authoring.createProject(
      seeded.scope,
      projectInput(seeded.character.id, [
        { characterId: seeded.character.id, narrativeRole: "البطل" },
        {
          characterId: friend.character.id,
          narrativeRole: "الصديق",
          appearance: { type: "shared_look", lookId: look.look.id },
        },
      ]),
    );

    expect(created.project.familyId).toBe(seeded.family.id);
    expect(created.version.storyConfig.participants).toHaveLength(2);
    expect(
      created.version.storyConfig.participants[0]?.characterVersionId,
    ).toBe(seeded.character.currentVersionId);
    expect(created.scenes).toHaveLength(12);
    expect(created.pageMap).toHaveLength(16);
    expect(created.story.status).toBe("draft");

    fixture.store.close();
    const reopened = new DocumentStore(fixture.database);
    const restarted = new AuthoringService(
      reopened,
      new LibraryService(reopened),
    );
    expect(
      restarted.getProjectWorkspace(seeded.scope, created.project.id).scenes,
    ).toHaveLength(12);
    reopened.close();
  });

  it("fails closed on cross-family references, archived anchors, and stale heads", async () => {
    const fixture = await authoringFixture();
    const source = seedFamily(fixture.library);
    const other = seedFamily(fixture.library, "أسرة أخرى");
    expect(() =>
      fixture.authoring.createProject(
        source.scope,
        projectInput(source.character.id, [
          { characterId: other.character.id, narrativeRole: "غريب" },
        ]),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "PROJECT_FAMILY_SCOPE_VIOLATION" }),
    );
    expect(fixture.authoring.listProjects(source.scope)).toEqual([]);

    fixture.library.archiveCharacter(source.scope, source.character.id);
    expect(() =>
      fixture.authoring.createProject(
        source.scope,
        projectInput(source.character.id),
      ),
    ).toThrowError(expect.objectContaining({ code: "FAMILY_ANCHOR_ARCHIVED" }));
    fixture.library.restoreCharacter(source.scope, source.character.id);
    const created = fixture.authoring.createProject(
      source.scope,
      projectInput(source.character.id),
    );
    expect(() =>
      fixture.authoring.updateProject(source.scope, created.project.id, {
        expectedVersionId: ulid(),
        input: projectInput(source.character.id, undefined, "عنوان جديد"),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PROJECT_VERSION_CONFLICT" }),
    );
    expect(
      fixture.authoring.getProjectWorkspace(source.scope, created.project.id)
        .version.id,
    ).toBe(created.version.id);
  });

  it("atomically appends a project-only override and one IM-04 event", async () => {
    const fixture = await authoringFixture();
    const seeded = seedFamily(fixture.library);
    const beforeCharacter = fixture.library.getCharacter(
      seeded.scope,
      seeded.character.id,
    );
    const beforeVersion = fixture.library.getCharacterVersion(
      seeded.scope,
      seeded.character.id,
      beforeCharacter.currentVersionId,
    );
    const created = fixture.authoring.createProject(
      seeded.scope,
      projectInput(seeded.character.id),
    );
    const result = fixture.authoring.appendProjectOverride(
      seeded.scope,
      created.project.id,
      {
        expectedProjectVersionId: created.version.id,
        characterId: seeded.character.id,
        clothing: "جاكيت أصفر للمشروع فقط",
        appearanceOverrides: { accessory: "شارة نجمة" },
      },
    );

    expect(result.event.matrixRow).toBe("IM-04");
    expect(
      result.projectVersion.storyConfig.participants[0]?.appearance,
    ).toEqual({
      type: "project_override",
      overrideId: result.override.id,
      overrideVersionId: result.overrideVersion.id,
    });
    expect(
      fixture.library.getCharacterVersion(
        seeded.scope,
        seeded.character.id,
        beforeVersion.id,
      ),
    ).toEqual(beforeVersion);
  });
});

describe("manual scenes and mention identity", () => {
  it("renders a renamed duplicate by ID and completes only with every valid scene", async () => {
    const fixture = await authoringFixture();
    const seeded = seedFamily(fixture.library, "أسرة أحمد", "أحمد");
    const friend = fixture.library.createCharacter(seeded.scope, {
      profile: profile({ name: "أَحْمَد", relationship: { type: "friend" } }),
    });
    const created = fixture.authoring.createProject(
      seeded.scope,
      projectInput(seeded.character.id, [
        { characterId: seeded.character.id, narrativeRole: "البطل" },
        { characterId: friend.character.id, narrativeRole: "الصديق" },
      ]),
    );
    const candidates = fixture.authoring.mentionCandidates(
      seeded.scope,
      created.project.id,
      "أحمد",
    );
    expect(candidates).toHaveLength(2);

    fixture.library.appendCharacterVersion(seeded.scope, {
      characterId: friend.character.id,
      expectedVersionId: friend.version.id,
      profile: { ...friend.version.profile, name: "علي" },
    });
    const renamed = fixture.authoring.mentionCandidates(
      seeded.scope,
      created.project.id,
      "علي",
    );
    expect(renamed).toEqual([
      expect.objectContaining({
        characterId: friend.character.id,
        displayName: "علي",
      }),
    ]);

    let workspace = created;
    for (const scene of workspace.scenes) {
      workspace = fixture.authoring.updateScene(
        seeded.scope,
        created.project.id,
        scene.scene.storyPageIndex,
        {
          expectedStoryVersionId: workspace.storyVersion.id,
          expectedSceneVersionId:
            workspace.scenes.find(
              (candidate) => candidate.scene.id === scene.scene.id,
            )?.version.id ?? scene.version.id,
          content: {
            purpose: `لحظة ${scene.scene.storyPageIndex}`,
            description: "مشهد آمن وواضح",
            documentSegments: [
              {
                type: "mention",
                characterId: seeded.character.id,
                props: mentionProps(),
              },
            ],
            environment: "مكان خيالي",
            timeOfDay: "نهار",
            composition: "واسع",
            cameraFraming: "متوسط",
            narrativeText: "كان البطل مستعدًا.",
            dialogue: [],
            twoImageMoment: false,
          },
        },
      );
    }
    expect(workspace.story.status).toBe("complete");
    expect(workspace.storyVersion.sceneVersionIds).toHaveLength(12);
  });
});

describe("template lifecycle and page-count confirmation", () => {
  it("installs seven seeds idempotently without overwriting lifecycle state", async () => {
    const fixture = await authoringFixture();
    expect(
      fixture.authoring.listTemplates({ includeHidden: true }),
    ).toHaveLength(7);
    const first = fixture.authoring.listTemplates({ includeHidden: true })[0];
    expect(() =>
      fixture.authoring.setTemplateStatus(first.id, {
        expectedVersionId: ulid(),
        expectedStatus: "active",
        status: "disabled",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_VERSION_CONFLICT" }),
    );
    expect(fixture.authoring.getTemplate(first.id).status).toBe("active");
    fixture.authoring.setTemplateStatus(first.id, {
      expectedVersionId: first.version.id,
      expectedStatus: "active",
      status: "disabled",
    });
    installSeedTemplates(fixture.store);
    expect(fixture.authoring.getTemplate(first.id).template.status).toBe(
      "disabled",
    );
    expect(
      fixture.authoring.listTemplates({ includeHidden: true }),
    ).toHaveLength(7);
  });

  it("rejects stale page-count plans and appends a 24-page draft revision", async () => {
    const fixture = await authoringFixture();
    const seeded = seedFamily(fixture.library);
    const created = fixture.authoring.createProject(
      seeded.scope,
      projectInput(seeded.character.id),
    );
    const plan = fixture.authoring.preflightPageCountChange(
      seeded.scope,
      created.project.id,
      24,
    );
    fixture.authoring.updateProject(seeded.scope, created.project.id, {
      expectedVersionId: created.version.id,
      input: projectInput(
        seeded.character.id,
        undefined,
        "تعديل يجعل الخطة قديمة",
      ),
    });
    expect(() =>
      fixture.authoring.confirmPageCountChange(
        seeded.scope,
        created.project.id,
        plan,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "PAGE_COUNT_PREFLIGHT_STALE" }),
    );
    const fresh = fixture.authoring.preflightPageCountChange(
      seeded.scope,
      created.project.id,
      24,
    );
    const changed = fixture.authoring.confirmPageCountChange(
      seeded.scope,
      created.project.id,
      fresh,
    );
    expect(changed.version.storyConfig.pageCount).toBe(24);
    expect(changed.scenes).toHaveLength(20);
    expect(changed.story.status).toBe("draft");
    expect(
      changed.scenes.filter((scene) => scene.version.needsAuthoring),
    ).toHaveLength(8);
    let authoredAdds = changed;
    for (const added of changed.scenes.filter(
      ({ version }) => version.needsAuthoring,
    )) {
      const current = authoredAdds.scenes.find(
        ({ scene }) => scene.storyPageIndex === added.scene.storyPageIndex,
      )!;
      authoredAdds = fixture.authoring.updateScene(
        seeded.scope,
        authoredAdds.project.id,
        current.scene.storyPageIndex,
        {
          expectedStoryVersionId: authoredAdds.storyVersion.id,
          expectedSceneVersionId: current.version.id,
          content: completeSceneContent([seeded.character.id]),
        },
      );
    }
    expect(authoredAdds.story.status).toBe("draft");
  });
});

describe("compile, removal, custom readiness, and privacy extraction", () => {
  it("compiles exact participants with explicit reconciliation and capacity acknowledgements", async () => {
    const fixture = await authoringFixture();
    const seeded = seedFamily(fixture.library);
    const friend = fixture.library.createCharacter(seeded.scope, {
      profile: profile({ name: "مريم", relationship: { type: "friend" } }),
    });
    let workspace = fixture.authoring.createProject(
      seeded.scope,
      projectInput(seeded.character.id, [
        { characterId: seeded.character.id, narrativeRole: "البطل" },
        { characterId: friend.character.id, narrativeRole: "الصديقة" },
      ]),
    );
    workspace = fixture.authoring.updateScene(
      seeded.scope,
      workspace.project.id,
      1,
      {
        expectedStoryVersionId: workspace.storyVersion.id,
        expectedSceneVersionId: workspace.scenes[0].version.id,
        content: completeSceneContent([
          seeded.character.id,
          friend.character.id,
        ]),
      },
    );
    expect(() =>
      fixture.authoring.compileScene(seeded.scope, workspace.project.id, 1, {
        selectedParticipantIds: [seeded.character.id, friend.character.id],
        capability: {
          mode: "verified",
          modelId: "synthetic-model",
          reliableReferenceCount: 1,
        },
        acknowledgements: { reconciliation: true, capacity: false },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PARTICIPANT_CAPACITY_CONFIRMATION_REQUIRED",
      }),
    );
    const compiled = fixture.authoring.compileScene(
      seeded.scope,
      workspace.project.id,
      1,
      {
        selectedParticipantIds: [seeded.character.id, friend.character.id],
        capability: {
          mode: "verified",
          modelId: "synthetic-model",
          reliableReferenceCount: 1,
        },
        acknowledgements: { reconciliation: true, capacity: true },
      },
    );
    expect(compiled.occurrences.map((item) => item.characterId)).toEqual([
      seeded.character.id,
      friend.character.id,
    ]);
    expect(compiled.warnings).toContainEqual(
      expect.objectContaining({ code: "PARTICIPANT_CAPACITY_EXCEEDED" }),
    );
  });

  it("preflights cancellation and rewrites referenced identities by explicit resolution", async () => {
    const fixture = await authoringFixture();
    const seeded = seedFamily(fixture.library);
    const friend = fixture.library.createCharacter(seeded.scope, {
      profile: profile({ name: "سلمى", relationship: { type: "friend" } }),
    });
    let workspace = fixture.authoring.createProject(
      seeded.scope,
      projectInput(seeded.character.id, [
        { characterId: seeded.character.id, narrativeRole: "البطل" },
        { characterId: friend.character.id, narrativeRole: "الصديقة" },
      ]),
    );
    workspace = fixture.authoring.updateScene(
      seeded.scope,
      workspace.project.id,
      1,
      {
        expectedStoryVersionId: workspace.storyVersion.id,
        expectedSceneVersionId: workspace.scenes[0].version.id,
        content: completeSceneContent([friend.character.id]),
      },
    );
    const beforeProject = workspace.version.id;
    const beforeScene = workspace.scenes[0].version.id;
    const preflight = fixture.authoring.preflightCharacterRemoval(
      seeded.scope,
      workspace.project.id,
      friend.character.id,
    );
    expect(preflight.affectedStoryPageIndexes).toEqual([1]);
    const canceled = fixture.authoring.resolveCharacterRemoval(
      seeded.scope,
      workspace.project.id,
      {
        expectedProjectVersionId: beforeProject,
        expectedStoryVersionId: workspace.storyVersion.id,
        characterId: friend.character.id,
        resolution: { type: "cancel" },
      },
    );
    expect(canceled.version.id).toBe(beforeProject);
    const replaced = fixture.authoring.resolveCharacterRemoval(
      seeded.scope,
      workspace.project.id,
      {
        expectedProjectVersionId: beforeProject,
        expectedStoryVersionId: workspace.storyVersion.id,
        characterId: friend.character.id,
        resolution: {
          type: "replace",
          replacementCharacterId: seeded.character.id,
        },
      },
    );
    expect(replaced.version.storyConfig.participants).toHaveLength(1);
    expect(
      replaced.scenes[0].version.content.documentSegments[0],
    ).toMatchObject({
      type: "mention",
      characterId: seeded.character.id,
    });
    expect(replaced.scenes[0].version.id).not.toBe(beforeScene);

    let removalWorkspace = fixture.authoring.createProject(
      seeded.scope,
      projectInput(seeded.character.id, [
        { characterId: seeded.character.id, narrativeRole: "البطل" },
        { characterId: friend.character.id, narrativeRole: "الصديقة" },
      ]),
    );
    removalWorkspace = fixture.authoring.updateScene(
      seeded.scope,
      removalWorkspace.project.id,
      1,
      {
        expectedStoryVersionId: removalWorkspace.storyVersion.id,
        expectedSceneVersionId: removalWorkspace.scenes[0].version.id,
        content: completeSceneContent([friend.character.id]),
      },
    );
    const removed = fixture.authoring.resolveCharacterRemoval(
      seeded.scope,
      removalWorkspace.project.id,
      {
        expectedProjectVersionId: removalWorkspace.version.id,
        expectedStoryVersionId: removalWorkspace.storyVersion.id,
        characterId: friend.character.id,
        resolution: { type: "remove_mentions" },
      },
    );
    expect(removed.scenes[0].version.content.documentSegments).toEqual([]);
  });

  it("saves incomplete custom drafts but blocks readiness with every missing field", async () => {
    const fixture = await authoringFixture();
    const seeded = seedFamily(fixture.library);
    const input = projectInput(seeded.character.id);
    input.storyType = "fully_custom";
    input.templateSeedKey = null;
    input.customStory = {
      premise: "",
      beginningBeat: "",
      middleBeat: "",
      endingBeat: "",
      contentBoundaries: [],
    };
    const created = fixture.authoring.createProject(seeded.scope, input);
    expect(() =>
      fixture.authoring.validateGenerationReadiness(
        seeded.scope,
        created.project.id,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CUSTOM_STORY_INCOMPLETE",
        details: {
          missingFields: [
            "premise",
            "beginningBeat",
            "middleBeat",
            "endingBeat",
            "contentBoundaries",
          ],
        },
      }),
    );
  });

  it("extracts an identity-free template and returns a cross-family remap draft", async () => {
    const fixture = await authoringFixture();
    const source = seedFamily(fixture.library, "عائلة المصدر", "ليلى");
    const target = seedFamily(fixture.library, "عائلة الهدف", "نور");
    let workspace = fixture.authoring.createProject(
      source.scope,
      projectInput(source.character.id),
    );
    workspace = authorAllScenes(fixture.authoring, source.scope, workspace);
    expect(() =>
      fixture.authoring.extractTemplateFromCompletedStory(
        source.scope,
        workspace.project.id,
        "قالب ليلى",
      ),
    ).toThrowError(expect.objectContaining({ code: "PRIVACY_SCAN_FAILED" }));
    const extracted = fixture.authoring.extractTemplateFromCompletedStory(
      source.scope,
      workspace.project.id,
      "قالب رحلة تعاونية",
    );
    expect(JSON.stringify(extracted)).not.toContain(source.character.id);
    expect(JSON.stringify(extracted)).not.toContain("ليلى");
    const sourceBefore = JSON.stringify(
      fixture.authoring.getProjectWorkspace(source.scope, workspace.project.id),
    );
    const sameFamilyCopy =
      fixture.authoring.duplicateCompletedStoryWithinFamily(
        source.scope,
        workspace.project.id,
        {
          expectedProjectVersionId: workspace.version.id,
          expectedStoryVersionId: workspace.storyVersion.id,
          title: "نسخة داخل العائلة",
        },
      );
    expect(sameFamilyCopy.project.id).not.toBe(workspace.project.id);
    expect(sameFamilyCopy.project.familyId).toBe(source.scope.familyId);
    expect(sameFamilyCopy.story.status).toBe("complete");
    expect(sameFamilyCopy.version.storyConfig.participants).toEqual(
      workspace.version.storyConfig.participants,
    );
    expect(sameFamilyCopy.scenes[0].version.sourceSceneVersionIds).toEqual([
      workspace.scenes[0].version.id,
    ]);
    expect(
      JSON.stringify(
        fixture.authoring.getProjectWorkspace(
          source.scope,
          workspace.project.id,
        ),
      ),
    ).toBe(sourceBefore);
    const draft = fixture.authoring.prepareCrossFamilyDuplicate(
      source.scope,
      workspace.project.id,
      target.scope,
    );
    expect(draft.status).toBe("role_remap_required");
    expect(JSON.stringify(draft)).not.toContain(source.scope.customerId);
    expect(() => assertCrossFamilyDraftReady(draft)).toThrowError(
      expect.objectContaining({ code: "CROSS_FAMILY_ROLE_REMAP_REQUIRED" }),
    );
    const remapped = draft.roleSlots
      .filter(({ required }) => required)
      .reduce(
        (current, slot) =>
          mapCrossFamilyRole(current, slot.slot, target.character.id),
        draft,
      );
    expect(remapped.status).toBe("ready");
    expect(() => assertCrossFamilyDraftReady(remapped)).not.toThrow();
  });
});

async function authoringFixture() {
  const directory = await temporaryDirectory("hekayati-authoring-");
  cleanups.push(directory.cleanup);
  const paths = resolveDataPaths(`${directory.path}/data`);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  installSeedTemplates(store);
  const library = new LibraryService(store);
  return {
    database: paths.database,
    store,
    library,
    authoring: new AuthoringService(store, library),
  };
}

function seedFamily(
  library: LibraryService,
  familyName = "أسرة تجريبية",
  childName = "ليلى",
) {
  const customer = library.createCustomer({
    name: `عميل ${familyName}`,
    whatsapp: "+201000000000",
    notes: "بيانات اصطناعية",
  });
  const family = library.createFamily({
    customerId: customer.id,
    name: familyName,
  });
  const scope = { customerId: customer.id, familyId: family.id };
  const created = library.createCharacter(scope, {
    profile: profile({
      name: childName,
      relationship: { type: "main_child" },
    }),
  });
  return { scope, customer, family, character: created.character };
}

function projectInput(
  mainChildId: string,
  participants: ProjectInput["participants"] = [
    { characterId: mainChildId, narrativeRole: "البطل" },
  ],
  title = "مغامرة الفضاء",
): ProjectInput {
  return {
    title,
    mainChildId,
    participants,
    occasion: "هدية",
    dedicationText: "إلى بطل الحكاية",
    storyType: "saved_template",
    templateSeedKey: "space_adventure",
    pageCount: 16,
    tone: "adventurous",
    customTone: null,
    illustrationStyleId: "modern_cartoon",
    hiddenGoal: {
      goal: "confidence",
      customGoal: null,
      presentation: "indirect",
    },
    clothingNotes: "ملابس مريحة",
    customNotes: "",
    audienceAgeBand: "age_6_8",
    readingLevel: "developing",
    sceneComplexity: "medium",
    selectedNarrationPercent: null,
    customStory: null,
    endingPages: {
      farewellText: "كان يومًا جميلًا.",
      brandLine: "صُنع خصيصًا للبطل",
    },
  };
}

function profile(overrides: Record<string, unknown> = {}): CharacterProfile {
  return characterProfileSchema.parse({
    name: "ليلى",
    nickname: null,
    relationship: { type: "sister" },
    appearanceDescription: "طفلة بشعر أسود",
    ageOrRange: "7",
    gender: "أنثى",
    skinTone: "قمحي",
    hair: "أسود",
    eyeColor: "بني",
    relativeHeight: "متوسط",
    build: "متوسط",
    distinguishingFeatures: [],
    glasses: null,
    hijab: null,
    accessories: [],
    interests: [],
    favoriteObjects: [],
    favoriteColor: null,
    personalityTraits: [],
    speakingStyle: null,
    notes: null,
    sourceMode: "description",
    referencePhotoIds: [],
    traits: {},
    ...overrides,
  });
}

function mentionProps() {
  return {
    action: "بيتحرك بثقة",
    emotion: "متحمس",
    position: null,
    framing: null,
    lookId: null,
    heldObject: null,
    gazeTarget: null,
    speaks: false,
    dialogue: null,
  };
}

function completeSceneContent(characterIds: string[]) {
  return {
    purpose: "لحظة واضحة",
    description: "مشهد آمن ومفهوم",
    documentSegments: characterIds.map((characterId) => ({
      type: "mention" as const,
      characterId,
      props: mentionProps(),
    })),
    environment: "مكان خيالي",
    timeOfDay: "نهار",
    composition: "واسع",
    cameraFraming: "متوسط",
    narrativeText: "كان الأبطال مستعدين.",
    dialogue: [],
    twoImageMoment: false,
  };
}

function authorAllScenes(
  authoring: AuthoringService,
  scope: { customerId: string; familyId: string },
  initial: ReturnType<AuthoringService["createProject"]>,
) {
  let workspace = initial;
  for (const scene of initial.scenes) {
    const current = workspace.scenes.find(
      (item) => item.scene.storyPageIndex === scene.scene.storyPageIndex,
    )!;
    workspace = authoring.updateScene(
      scope,
      workspace.project.id,
      scene.scene.storyPageIndex,
      {
        expectedStoryVersionId: workspace.storyVersion.id,
        expectedSceneVersionId: current.version.id,
        content: completeSceneContent([
          workspace.version.storyConfig.mainChildId,
        ]),
      },
    );
  }
  return workspace;
}
