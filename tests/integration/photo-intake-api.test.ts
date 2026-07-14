import { readFile, readdir } from "node:fs/promises";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../../src/server/app.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("atomic photo intake HTTP flow", () => {
  it("stages only a safe preview, retries subject confirmation, and persists atomically without consent", async () => {
    const fixture = await runtimeFixture();
    const customer = await jsonMutation(fixture, "/api/library/customers", {
      name: "عميل صورة اصطناعية",
      whatsapp: "",
      notes: "",
    });
    expect(customer.consent).toBeNull();
    const family = await jsonMutation(
      fixture,
      `/api/library/customers/${customer.id}/families`,
      { name: "عائلة الصورة" },
    );
    const staged = await stagePhoto(
      fixture,
      family.id,
      {
        type: "new_character",
        draft: profile("طفل اصطناعي", "main_child", "photo"),
      },
      await syntheticPng(),
      "face",
    );

    expect(staged.reservationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(staged.thumbnailUrl).not.toContain(staged.reservationToken);
    expect(staged).toMatchObject({ kind: "face", widthPx: 80, heightPx: 64 });
    const preview = await fetch(`${fixture.origin}${staged.thumbnailUrl}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toContain("image/jpeg");
    expect(preview.headers.get("cache-control")).toContain("no-store");
    expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const missingPeopleCount = await rawJsonMutation(
      fixture,
      "/api/library/photo-intake/commit",
      {
        ...commitBody(staged.reservationToken, true),
        observations: {},
      },
    );
    expect(missingPeopleCount.status).toBe(422);
    expect(await missingPeopleCount.json()).toMatchObject({
      code: "PHOTO_SUBJECT_SELECTION_REQUIRED",
    });

    const missingOperatorConfirmation = await rawJsonMutation(
      fixture,
      "/api/library/photo-intake/commit",
      {
        ...commitBody(staged.reservationToken, true),
        subjectSelectionConfirmed: undefined,
        observations: { peopleCount: 1 },
      },
    );
    expect(missingOperatorConfirmation.status).toBe(422);
    expect(await missingOperatorConfirmation.json()).toMatchObject({
      code: "PHOTO_SUBJECT_SELECTION_REQUIRED",
    });

    const unconfirmed = await rawJsonMutation(
      fixture,
      "/api/library/photo-intake/commit",
      commitBody(staged.reservationToken, false),
    );
    expect(unconfirmed.status).toBe(422);
    expect(await unconfirmed.json()).toMatchObject({
      code: "PHOTO_SUBJECT_SELECTION_REQUIRED",
    });

    const fullFrameFace = await rawJsonMutation(
      fixture,
      "/api/library/photo-intake/commit",
      {
        ...commitBody(staged.reservationToken, true),
        subjectSelection: { x: 0, y: 0, width: 1, height: 1 },
      },
    );
    expect(fullFrameFace.status).toBe(422);
    expect(await fullFrameFace.json()).toMatchObject({
      code: "PHOTO_SUBJECT_SELECTION_REQUIRED",
    });

    const committed = await jsonMutation(
      fixture,
      "/api/library/photo-intake/commit",
      commitBody(staged.reservationToken, true),
    );
    expect(committed).toMatchObject({
      action: "attached",
      characterId: expect.any(String),
      referencePhotoId: expect.any(String),
      referencePhoto: {
        id: expect.any(String),
        thumbnailUrl: expect.stringContaining("/thumbnail"),
        quality: {
          policyVersion: expect.any(String),
          warnings: expect.any(Array),
          observations: { peopleCount: 2 },
        },
      },
    });
    expect(JSON.stringify(committed.referencePhoto)).not.toMatch(
      /originalAssetId|workingAssetId|providerAssetId/,
    );
    const committedThumbnail = await fetch(
      `${fixture.origin}${committed.referencePhoto.thumbnailUrl}`,
    );
    expect(committedThumbnail.status).toBe(200);
    expect(committedThumbnail.headers.get("content-type")).toContain(
      "image/jpeg",
    );
    expect(committedThumbnail.headers.get("cache-control")).toContain(
      "no-store",
    );
    const snapshot = await getJson(fixture.origin, "/api/library");
    expect(snapshot.characters).toHaveLength(1);
    expect(snapshot.characters[0].currentVersion.profile).toMatchObject({
      sourceMode: "photo",
      referencePhotoIds: [committed.referencePhotoId],
    });
    expect(snapshot.referencePhotos).toEqual([committed.referencePhoto]);
    expect(await managedFileCount(fixture.runtime.paths.originals)).toBe(1);
    expect(await managedFileCount(fixture.runtime.paths.assets)).toBe(3);

    const originalProbe = await fetch(
      `${fixture.origin}/api/library/originals/${committed.referencePhotoId}`,
    );
    expect(originalProbe.status).toBe(404);

    const stagedNonFace = await stagePhoto(
      fixture,
      family.id,
      { type: "character", characterId: committed.characterId },
      await syntheticPng(),
      "other",
    );
    const roundedFullFrameNonFace = await rawJsonMutation(
      fixture,
      "/api/library/photo-intake/commit",
      {
        ...commitBody(stagedNonFace.reservationToken, true),
        subjectSelection: { x: 0, y: 0, width: 0.999, height: 0.999 },
      },
    );
    expect(roundedFullFrameNonFace.status).toBe(422);
    expect(await roundedFullFrameNonFace.json()).toMatchObject({
      code: "PHOTO_SUBJECT_SELECTION_REQUIRED",
    });

    const committedNonFace = await jsonMutation(
      fixture,
      "/api/library/photo-intake/commit",
      commitBody(stagedNonFace.reservationToken, true),
    );
    expect(committedNonFace).toMatchObject({
      action: "attached",
      characterId: committed.characterId,
      referencePhoto: { kind: "other" },
    });
    expect(
      (await getJson(fixture.origin, "/api/library")).referencePhotos,
    ).toHaveLength(2);
  });

  it("rejects cross-family owners and over-limit bytes, and cancellation leaves no character", async () => {
    const fixture = await runtimeFixture();
    const first = await createFamily(fixture, "الأولى");
    const second = await createFamily(fixture, "الثانية");
    const anchorProfile = profile("مرساة", "main_child", "description");
    const anchorPreflight = await jsonMutation(
      fixture,
      `/api/library/families/${first.family.id}/characters/preflight`,
      { profile: anchorProfile },
    );
    const anchor = await jsonMutation(
      fixture,
      `/api/library/families/${first.family.id}/characters`,
      {
        profile: anchorProfile,
        preflightToken: anchorPreflight.preflightToken,
      },
    );
    const image = await syntheticPng();

    const bypass = await rawStagePhoto(
      fixture,
      second.family.id,
      { type: "character", characterId: anchor.id },
      image,
      "other",
    );
    expect(bypass.status).toBe(403);
    expect(await bypass.json()).toEqual({ code: "FAMILY_SCOPE_MISMATCH" });

    const malformedOwnerCanary = "PRIVATE_OWNER_PAYLOAD_CANARY";
    const malformed = await rawStagePhotoWithOwnerText(
      fixture,
      second.family.id,
      `{${malformedOwnerCanary}`,
      image,
      "other",
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      code: "PHOTO_DECODE_FAILED",
    });
    expect(
      await readFile(`${fixture.runtime.paths.logs}/app.log`, "utf8"),
    ).not.toContain(malformedOwnerCanary);

    const staged = await stagePhoto(
      fixture,
      second.family.id,
      {
        type: "new_character",
        draft: profile("ملغاة", "main_child", "photo"),
      },
      image,
      "other",
    );
    const unsafeMultiplePeople = await rawJsonMutation(
      fixture,
      "/api/library/photo-intake/commit",
      {
        reservationToken: staged.reservationToken,
        intendedPersonConfirmed: true,
        observations: { peopleCount: 2 },
        duplicateDecision: { action: "create_separate" },
      },
    );
    expect(unsafeMultiplePeople.status).toBe(422);
    expect(await unsafeMultiplePeople.json()).toMatchObject({
      code: "PHOTO_SUBJECT_SELECTION_REQUIRED",
    });
    const cancelled = await rawJsonMutation(
      fixture,
      "/api/library/photo-intake/cancel",
      { reservationToken: staged.reservationToken },
    );
    expect(cancelled.status).toBe(204);
    const afterCancel = await rawJsonMutation(
      fixture,
      "/api/library/photo-intake/commit",
      {
        reservationToken: staged.reservationToken,
        observations: {},
        duplicateDecision: { action: "create_separate" },
      },
    );
    expect(afterCancel.status).toBe(404);

    const settings = await getJson(fixture.origin, "/api/settings");
    await jsonMutation(
      fixture,
      "/api/settings",
      {
        ...settingsUpdate(settings),
        photoUploadMaxMb: 1,
      },
      "PUT",
    );
    const oversized = await rawStagePhoto(
      fixture,
      second.family.id,
      {
        type: "new_character",
        draft: profile("كبيرة", "main_child", "photo"),
      },
      Buffer.alloc(1024 * 1024 + 2, 1),
      "other",
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      code: "PHOTO_FILE_TOO_LARGE",
    });
    const snapshot = await getJson(fixture.origin, "/api/library");
    expect(
      snapshot.characters.filter(
        (character: { familyId: string }) =>
          character.familyId === second.family.id,
      ),
    ).toEqual([]);
  });
});

async function runtimeFixture() {
  const directory = await temporaryDirectory("hekayati-photo-api-");
  const runtime = await createRuntime({
    dataDir: directory.path,
    serveUi: false,
  });
  const origin = await runtime.start();
  const bootstrap = await getJson(origin, "/api/bootstrap");
  const fixture = { runtime, origin, token: bootstrap.csrfToken as string };
  cleanups.push(() => runtime.close(), directory.cleanup);
  return fixture;
}

async function createFamily(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  label: string,
) {
  const customer = await jsonMutation(fixture, "/api/library/customers", {
    name: `عميل ${label}`,
    whatsapp: "",
    notes: "",
  });
  const family = await jsonMutation(
    fixture,
    `/api/library/customers/${customer.id}/families`,
    { name: `عائلة ${label}` },
  );
  return { customer, family };
}

function profile(
  name: string,
  relationship: "main_child",
  sourceMode: "photo" | "description",
) {
  return {
    name,
    nickname: "",
    relationship: { type: relationship },
    appearanceDescription:
      sourceMode === "description" ? `${name} بوصف اصطناعي` : "",
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
    sourceMode,
    referencePhotoIds: [],
    traits: {},
  };
}

async function syntheticPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 80,
      height: 64,
      channels: 3,
      background: "#f5a623",
    },
  })
    .png()
    .toBuffer();
}

function commitBody(token: string, confirmed: boolean) {
  return {
    reservationToken: token,
    subjectSelection: { x: 0.2, y: 0.2, width: 0.5, height: 0.6 },
    subjectSelectionConfirmed: true,
    intendedPersonConfirmed: confirmed,
    observations: { peopleCount: 2 },
    duplicateDecision: { action: "create_separate" },
  };
}

async function stagePhoto(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  familyId: string,
  owner: unknown,
  bytes: Buffer,
  kind: "face" | "other",
) {
  const response = await rawStagePhoto(fixture, familyId, owner, bytes, kind);
  expect(response.status).toBe(200);
  return response.json();
}

function rawStagePhoto(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  familyId: string,
  owner: unknown,
  bytes: Buffer,
  kind: "face" | "other",
) {
  return rawStagePhotoWithOwnerText(
    fixture,
    familyId,
    JSON.stringify(owner),
    bytes,
    kind,
  );
}

function rawStagePhotoWithOwnerText(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  familyId: string,
  owner: string,
  bytes: Buffer,
  kind: "face" | "other",
) {
  const form = new FormData();
  form.set("familyId", familyId);
  form.set("kind", kind);
  form.set("owner", owner);
  form.set(
    "file",
    new Blob([Uint8Array.from(bytes).buffer], { type: "image/png" }),
    "synthetic.png",
  );
  return fetch(`${fixture.origin}/api/library/photo-intake/stage`, {
    method: "POST",
    headers: secureHeaders(fixture),
    body: form,
  });
}

async function jsonMutation(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  path: string,
  body: unknown,
  method = "POST",
) {
  const response = await rawJsonMutation(fixture, path, body, method);
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.status === 204 ? undefined : response.json();
}

function rawJsonMutation(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
  path: string,
  body: unknown,
  method = "POST",
) {
  return fetch(`${fixture.origin}${path}`, {
    method,
    headers: {
      ...secureHeaders(fixture),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  expect(response.status).toBe(200);
  return response.json();
}

function secureHeaders(fixture: Awaited<ReturnType<typeof runtimeFixture>>) {
  return { origin: fixture.origin, "x-hekayati-csrf": fixture.token };
}

function settingsUpdate(settings: Record<string, unknown>) {
  const writable = [
    "textProvider",
    "imageProvider",
    "geminiImageTier",
    "models",
    "concurrencyPerProvider",
    "typography",
    "watermarkText",
    "diskWarnGb",
    "photoUploadMaxMb",
    "photoMaxMegapixels",
    "firstRunAcknowledged",
  ];
  return Object.fromEntries(writable.map((key) => [key, settings[key]]));
}

async function managedFileCount(root: string): Promise<number> {
  const prefixes = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    prefixes
      .filter((entry) => entry.isDirectory())
      .map((entry) => readdir(`${root}/${entry.name}`)),
  );
  return files.flat().length;
}
