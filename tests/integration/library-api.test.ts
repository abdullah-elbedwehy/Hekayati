import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../src/server/app.js";
import { httpRequest } from "../helpers/http.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("customer and character library HTTP boundary", () => {
  it("serves the Arabic UI read model and durable versioned lifecycle", async () => {
    const directory = await temporaryDirectory("hekayati-library-api-");
    cleanups.push(directory.cleanup);
    let runtime = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
    });
    let origin = await runtime.start();
    let token = (await getJson(origin, "/api/bootstrap")).csrfToken as string;
    expect(await getJson(origin, "/api/library")).toEqual({
      customers: [],
      families: [],
      characters: [],
      looks: [],
      referencePhotos: [],
    });

    const customer = await sendJson(origin, token, "/api/library/customers", {
      name: "عميل اصطناعي",
      whatsapp: "+201000000000",
      notes: "اختبار محلي",
    });
    const consent = await sendJson(
      origin,
      token,
      `/api/library/customers/${customer.id}/consent`,
      {
        consent: {
          granted: true,
          date: new Date().toISOString(),
          note: "موافقة اختبارية",
        },
      },
    );
    expect(consent.consent.granted).toBe(true);
    const family = await sendJson(
      origin,
      token,
      `/api/library/customers/${customer.id}/families`,
      { name: "عائلة اختبارية" },
    );
    const renamedFamily = await patchJson(
      origin,
      token,
      `/api/library/families/${family.id}`,
      { name: "عائلة محدثة" },
    );
    expect(renamedFamily.name).toBe("عائلة محدثة");

    const unpreflighted = await rawJson(
      origin,
      token,
      `/api/library/families/${family.id}/characters`,
      { profile: profile("محاولة صامتة", "main_child") },
    );
    expect(unpreflighted.status).toBe(400);
    expect(JSON.parse(unpreflighted.body).code).toBe("INVALID_INPUT");

    const wrongProfile = profile("الأب", "father");
    const wrongPreflight = await characterPreflight(
      origin,
      token,
      family.id,
      wrongProfile,
    );
    const wrongFirst = await rawJson(
      origin,
      token,
      `/api/library/families/${family.id}/characters`,
      { profile: wrongProfile, preflightToken: wrongPreflight.preflightToken },
    );
    expect(wrongFirst.status).toBe(409);
    expect(JSON.parse(wrongFirst.body)).toEqual({
      code: "FAMILY_ANCHOR_REQUIRED",
    });

    const anchor = await createCharacter(
      origin,
      token,
      family.id,
      profile("ليلى", "main_child"),
    );
    expect(anchor.currentVersion.profile.name).toBe("ليلى");
    expect(anchor.versionCount).toBe(1);
    const fatherProfile = profile("محمود", "father");
    const father = await createCharacter(
      origin,
      token,
      family.id,
      fatherProfile,
    );

    const duplicatePreflight = await characterPreflight(
      origin,
      token,
      family.id,
      fatherProfile,
    );
    expect(duplicatePreflight.duplicateCandidates).toMatchObject([
      { characterId: father.id, name: "محمود" },
    ]);
    const duplicate = await rawJson(
      origin,
      token,
      `/api/library/families/${family.id}/characters`,
      {
        profile: fatherProfile,
        preflightToken: duplicatePreflight.preflightToken,
      },
    );
    expect(duplicate.status).toBe(409);
    expect(JSON.parse(duplicate.body)).toEqual({
      code: "DUPLICATE_DECISION_REQUIRED",
    });
    const confirmedPreflight = await characterPreflight(
      origin,
      token,
      family.id,
      fatherProfile,
    );
    await sendJson(
      origin,
      token,
      `/api/library/families/${family.id}/characters`,
      {
        profile: fatherProfile,
        preflightToken: confirmedPreflight.preflightToken,
        duplicateDecision: { action: "create_separate" },
      },
    );

    const racingProfile = profile("سلمى", "father");
    const stalePreflight = await characterPreflight(
      origin,
      token,
      family.id,
      racingProfile,
    );
    expect(stalePreflight.duplicateCandidates).toEqual([]);
    await createCharacter(origin, token, family.id, racingProfile);
    const staleCreate = await rawJson(
      origin,
      token,
      `/api/library/families/${family.id}/characters`,
      {
        profile: racingProfile,
        preflightToken: stalePreflight.preflightToken,
      },
    );
    expect(staleCreate.status).toBe(409);
    expect(JSON.parse(staleCreate.body)).toEqual({
      code: "DUPLICATE_DECISION_REQUIRED",
    });

    const updated = await patchJson(
      origin,
      token,
      `/api/library/characters/${father.id}`,
      {
        intent: "update_base",
        expectedVersionId: father.currentVersionId,
        profile: { ...father.currentVersion.profile, hair: "أسود قصير" },
      },
    );
    expect(updated.versionCount).toBe(2);
    const history = await getJson(
      origin,
      `/api/library/characters/${father.id}/history`,
    );
    expect(history.map((version: { id: string }) => version.id)).toEqual([
      father.currentVersionId,
      updated.currentVersionId,
    ]);

    const look = await sendJson(
      origin,
      token,
      `/api/library/characters/${father.id}/looks`,
      {
        name: "يومي",
        clothing: "قميص أزرق",
        appearanceOverrides: {},
        referencePhotoIds: [],
      },
    );
    const editedLook = await patchJson(
      origin,
      token,
      `/api/library/looks/${look.id}`,
      {
        expectedVersionId: look.currentVersionId,
        name: "يومي",
        clothing: "قميص أخضر",
        appearanceOverrides: {},
        referencePhotoIds: [],
      },
    );
    expect(editedLook.currentVersion.clothing).toBe("قميص أخضر");

    const stale = await rawJson(
      origin,
      token,
      `/api/library/looks/${look.id}`,
      {
        expectedVersionId: look.currentVersionId,
        name: "قديم",
        clothing: "قديم",
        appearanceOverrides: {},
        referencePhotoIds: [],
      },
      "PATCH",
    );
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toEqual({ code: "STALE_VERSION_HEAD" });

    await runtime.close();
    runtime = await createRuntime({ dataDir: directory.path, serveUi: false });
    cleanups.push(() => runtime.close());
    origin = await runtime.start();
    token = (await getJson(origin, "/api/bootstrap")).csrfToken as string;
    const persisted = await getJson(origin, "/api/library");
    expect(persisted.customers).toHaveLength(1);
    expect(persisted.families[0].name).toBe("عائلة محدثة");
    expect(persisted.characters).toHaveLength(4);
    expect(persisted.looks[0].versionCount).toBe(2);

    const deletion = await httpRequest(
      origin,
      `/api/library/customers/${customer.id}`,
      {
        method: "DELETE",
        headers: secureHeaders(origin, token),
      },
    );
    expect(deletion.status).toBe(404);
  });
});

function profile(name: string, relationship: "main_child" | "father") {
  return {
    name,
    nickname: "",
    relationship: { type: relationship },
    appearanceDescription: `${name} بوصف اصطناعي`,
    ageOrRange: "",
    gender: "",
    skinTone: "",
    hair: "",
    eyeColor: "",
    relativeHeight: "",
    build: "",
    distinguishingFeatures: [],
    glasses: "",
    hijab: "",
    accessories: [],
    interests: [],
    favoriteObjects: [],
    favoriteColor: "",
    personalityTraits: [],
    speakingStyle: "",
    notes: "",
    sourceMode: "description",
    referencePhotoIds: [],
    traits: {},
  };
}

async function getJson(origin: string, path: string) {
  const response = await httpRequest(origin, path);
  expect(response.status).toBe(200);
  return JSON.parse(response.body);
}

async function sendJson(
  origin: string,
  token: string,
  path: string,
  body: unknown,
) {
  const response = await rawJson(origin, token, path, body);
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return JSON.parse(response.body);
}

async function patchJson(
  origin: string,
  token: string,
  path: string,
  body: unknown,
) {
  const response = await rawJson(origin, token, path, body, "PATCH");
  expect(response.status).toBe(200);
  return JSON.parse(response.body);
}

async function characterPreflight(
  origin: string,
  token: string,
  familyId: string,
  profileValue: ReturnType<typeof profile>,
) {
  return sendJson(
    origin,
    token,
    `/api/library/families/${familyId}/characters/preflight`,
    { profile: profileValue },
  );
}

async function createCharacter(
  origin: string,
  token: string,
  familyId: string,
  profileValue: ReturnType<typeof profile>,
) {
  const preflight = await characterPreflight(
    origin,
    token,
    familyId,
    profileValue,
  );
  expect(preflight.duplicateCandidates).toEqual([]);
  return sendJson(
    origin,
    token,
    `/api/library/families/${familyId}/characters`,
    { profile: profileValue, preflightToken: preflight.preflightToken },
  );
}

function rawJson(
  origin: string,
  token: string,
  path: string,
  body: unknown,
  method = "POST",
) {
  return httpRequest(origin, path, {
    method,
    headers: {
      ...secureHeaders(origin, token),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function secureHeaders(origin: string, token: string) {
  return { origin, "x-hekayati-csrf": token };
}
