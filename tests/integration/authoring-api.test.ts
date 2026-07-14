import { afterEach, describe, expect, it } from "vitest";

import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import {
  characterProfileSchema,
  LibraryService,
  type CharacterProfile,
} from "../../src/domain/library/index.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { createRuntime } from "../../src/server/app.js";
import { httpRequest } from "../helpers/http.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("authoring local API", () => {
  it("installs seeds, creates scoped slots, and confirms a guarded page plan", async () => {
    const fixture = await apiFixture();
    const templates = await getJson(
      fixture.origin,
      "/api/authoring/templates?includeHidden=true",
    );
    expect(templates).toHaveLength(7);
    const createdResponse = await mutate(
      fixture,
      `/api/authoring/families/${fixture.familyId}/projects`,
      projectInput(fixture.characterId),
    );
    expect(createdResponse.status).toBe(200);
    const created = JSON.parse(createdResponse.body);
    expect(created.scenes).toHaveLength(12);
    expect(created.pageMap).toHaveLength(16);
    const list = await getJson(
      fixture.origin,
      `/api/authoring/projects?familyId=${fixture.familyId}`,
    );
    expect(list).toHaveLength(1);
    const planResponse = await mutate(
      fixture,
      `/api/authoring/projects/${created.project.id}/page-count/preflight?familyId=${fixture.familyId}`,
      { to: 24 },
    );
    expect(planResponse.status).toBe(200);
    const plan = JSON.parse(planResponse.body);
    expect(
      plan.operations.filter((item: { type: string }) => item.type === "add"),
    ).toHaveLength(8);
    const confirmed = await mutate(
      fixture,
      `/api/authoring/projects/${created.project.id}/page-count/confirm?familyId=${fixture.familyId}`,
      plan,
    );
    expect(confirmed.status).toBe(200);
    expect(JSON.parse(confirmed.body).scenes).toHaveLength(20);
  });

  it("maps scope and stale semantic failures without exposing server data", async () => {
    const fixture = await apiFixture();
    const created = JSON.parse(
      (
        await mutate(
          fixture,
          `/api/authoring/families/${fixture.familyId}/projects`,
          projectInput(fixture.characterId),
        )
      ).body,
    );
    const directChange = await patch(
      fixture,
      `/api/authoring/projects/${created.project.id}?familyId=${fixture.familyId}`,
      {
        expectedVersionId: created.version.id,
        input: { ...projectInput(fixture.characterId), pageCount: 24 },
      },
    );
    expect(directChange.status).toBe(409);
    expect(JSON.parse(directChange.body)).toEqual({
      code: "PAGE_COUNT_PREFLIGHT_REQUIRED",
    });
    const foreign = await httpRequest(
      fixture.origin,
      `/api/authoring/projects/${created.project.id}?familyId=${fixture.otherFamilyId}`,
    );
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).code).toBe(
      "PROJECT_FAMILY_SCOPE_VIOLATION",
    );
  });
});

async function apiFixture() {
  const directory = await temporaryDirectory("hekayati-authoring-api-");
  cleanups.push(directory.cleanup);
  const paths = resolveDataPaths(directory.path);
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  const library = new LibraryService(store);
  const source = seedFamily(library, "عائلة المصدر", "ليلى");
  const target = seedFamily(library, "عائلة أخرى", "نور");
  store.close();
  const runtime = await createRuntime({
    dataDir: directory.path,
    serveUi: false,
  });
  cleanups.push(() => runtime.close());
  const origin = await runtime.start();
  const bootstrap = await getJson(origin, "/api/bootstrap");
  return {
    runtime,
    origin,
    csrfToken: bootstrap.csrfToken as string,
    familyId: source.familyId,
    characterId: source.characterId,
    otherFamilyId: target.familyId,
  };
}

function seedFamily(
  library: LibraryService,
  familyName: string,
  childName: string,
) {
  const customer = library.createCustomer({
    name: familyName,
    whatsapp: "+201000000000",
    notes: "synthetic",
  });
  const family = library.createFamily({
    customerId: customer.id,
    name: familyName,
  });
  const scope = { customerId: customer.id, familyId: family.id };
  const character = library.createCharacter(scope, {
    profile: profile(childName),
  });
  return { familyId: family.id, characterId: character.character.id };
}

function profile(name: string): CharacterProfile {
  return characterProfileSchema.parse({
    name,
    nickname: null,
    relationship: { type: "main_child" },
    appearanceDescription: "طفل اصطناعي",
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
  });
}

function projectInput(mainChildId: string) {
  return {
    title: "مغامرة API",
    mainChildId,
    participants: [{ characterId: mainChildId, narrativeRole: "البطل" }],
    occasion: "هدية",
    dedicationText: "إهداء اصطناعي",
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
    clothingNotes: "",
    customNotes: "",
    audienceAgeBand: "age_6_8",
    readingLevel: "developing",
    sceneComplexity: "medium",
    selectedNarrationPercent: null,
    customStory: null,
    endingPages: { farewellText: "وداع", brandLine: "صُنع خصيصًا للبطل" },
  };
}

type Fixture = Awaited<ReturnType<typeof apiFixture>>;

async function getJson(origin: string, path: string) {
  const response = await httpRequest(origin, path);
  expect(response.status).toBe(200);
  return JSON.parse(response.body);
}

function mutate(fixture: Fixture, path: string, body: unknown) {
  return requestJson(fixture, path, "POST", body);
}

function patch(fixture: Fixture, path: string, body: unknown) {
  return requestJson(fixture, path, "PATCH", body);
}

function requestJson(
  fixture: Fixture,
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
) {
  return httpRequest(fixture.origin, path, {
    method,
    headers: {
      origin: fixture.origin,
      "x-hekayati-csrf": fixture.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
