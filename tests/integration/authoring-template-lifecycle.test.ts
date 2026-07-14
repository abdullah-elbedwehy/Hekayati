import { afterEach, describe, expect, it } from "vitest";

import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import {
  AuthoringService,
  installSeedTemplates,
  type ProjectInput,
  type TemplateRecord,
} from "../../src/domain/authoring/index.js";
import {
  characterProfileSchema,
  LibraryService,
} from "../../src/domain/library/index.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("immutable template lifecycle", () => {
  it("keeps pinned bytes while editing, duplicating, hiding, and restoring", async () => {
    const fixture = await templateFixture();
    const seeded = seedFamily(fixture.library);
    const first = fixture.authoring.listTemplates()[0];
    const input = projectInput(seeded.characterId, first.id);
    const project = fixture.authoring.createProject(seeded.scope, input);
    const updated = fixture.authoring.updateTemplate(first.id, {
      expectedVersionId: first.version.id,
      content: { ...first.version.content, name: "قالب محرر" },
    });
    installSeedTemplates(fixture.store);
    expect(fixture.authoring.getTemplate(first.id).version.id).toBe(
      updated.version.id,
    );
    expect(
      fixture.authoring.getTemplate(first.id, first.version.id).version.content,
    ).toEqual(first.version.content);
    expect(project.version.storyConfig.templateVersionId).toBe(
      first.version.id,
    );
    const duplicate = fixture.authoring.duplicateTemplate(first.id);
    expect(duplicate.id).not.toBe(first.id);
    expect(fixture.authoring.getTemplate(first.id).version.content.name).toBe(
      "قالب محرر",
    );
    setLifecycle(fixture.authoring, updated, "archived");
    expect(fixture.authoring.listTemplates().map(({ id }) => id)).not.toContain(
      first.id,
    );
    setLifecycle(
      fixture.authoring,
      fixture.authoring.getTemplate(first.id),
      "active",
    );
    setLifecycle(
      fixture.authoring,
      fixture.authoring.getTemplate(first.id),
      "disabled",
    );
    expect(() =>
      fixture.authoring.createProject(seeded.scope, input),
    ).toThrowError(
      expect.objectContaining({ code: "TEMPLATE_NOT_SELECTABLE" }),
    );
    expect(
      fixture.authoring.getProjectWorkspace(seeded.scope, project.project.id)
        .version.storyConfig.templateVersionId,
    ).toBe(first.version.id);
  });
});

async function templateFixture() {
  const directory = await temporaryDirectory("hekayati-template-lifecycle-");
  cleanups.push(directory.cleanup);
  const paths = resolveDataPaths(directory.path);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  cleanups.push(async () => store.close());
  installSeedTemplates(store);
  const library = new LibraryService(store);
  return {
    store,
    library,
    authoring: new AuthoringService(store, library),
  };
}

function seedFamily(library: LibraryService) {
  const customer = library.createCustomer({
    name: "عميل القالب",
    whatsapp: "+201000000000",
    notes: "synthetic",
  });
  const family = library.createFamily({
    customerId: customer.id,
    name: "عائلة القالب",
  });
  const scope = { customerId: customer.id, familyId: family.id };
  const character = library.createCharacter(scope, {
    profile: characterProfileSchema.parse({
      name: "نور",
      nickname: null,
      relationship: { type: "main_child" },
      appearanceDescription: "طفلة اصطناعية",
      ageOrRange: "7",
      gender: "",
      skinTone: "",
      hair: "",
      eyeColor: "",
      relativeHeight: "",
      build: "",
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
    }),
  });
  return { scope, characterId: character.character.id };
}

function projectInput(mainChildId: string, templateId: string): ProjectInput {
  return {
    title: "قصة مثبتة",
    mainChildId,
    participants: [{ characterId: mainChildId, narrativeRole: "البطل" }],
    occasion: "هدية",
    dedicationText: "إهداء",
    storyType: "saved_template",
    templateId,
    templateSeedKey: null,
    pageCount: 16,
    tone: "adventurous",
    customTone: null,
    illustrationStyleId: "modern_cartoon",
    hiddenGoal: null,
    clothingNotes: "",
    customNotes: "",
    audienceAgeBand: "age_6_8",
    readingLevel: "developing",
    sceneComplexity: "medium",
    selectedNarrationPercent: null,
    customStory: null,
    endingPages: { farewellText: "وداع", brandLine: "صُنع خصيصًا" },
  };
}

function setLifecycle(
  authoring: AuthoringService,
  record: TemplateRecord,
  status: "active" | "archived" | "disabled",
) {
  return authoring.setTemplateStatus(record.id, {
    expectedVersionId: record.version.id,
    expectedStatus: record.status,
    status,
  });
}
