import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import {
  createSyntheticPng,
  expectAccessible,
  expectCrossFamilyRefused,
  expectFullFrameMultiPersonRefused,
  expectKeyboardFocus,
  expectViewportFit,
  getCsrfToken,
  getLibrary,
  managedFileCount,
  monitorExternalRequests,
  type LibrarySnapshot,
  type StagedPhoto,
} from "./support/library-fixture.js";
import {
  beginPhotoCharacter,
  createCustomer,
  createDescriptionCharacter,
  createFamily,
  createLook,
  lookRow,
  openLibrary,
  recordConsent,
  renameFamily,
  selectCharacter,
  selectFamily,
} from "./support/library-ui.js";
import {
  reservePort,
  startApp,
  stopApp,
  type RunningApp,
} from "./support/running-app.js";

test.setTimeout(150_000);

interface Journey {
  page: Page;
  request: APIRequestContext;
  origin: string;
  dataDir: string;
  imagePath: string;
}

const FAMILY_NAME = "عائلة البرتقال";
const RENAMED_FAMILY = "عائلة البرتقال الآمنة";

test("provider-free library journey survives an interrupted intake and restart", async ({
  page,
  request,
}) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hekayati-e2e-library-"));
  const dataDir = join(temporaryRoot, "data");
  const imagePath = join(temporaryRoot, "synthetic-person.png");
  const port = await reservePort();
  const externalRequests = monitorExternalRequests(page);
  let running: RunningApp | null = null;
  try {
    await createSyntheticPng(imagePath);
    running = await startApp(dataDir, port);
    const journey = {
      page,
      request,
      dataDir,
      imagePath,
      origin: running.origin,
    };
    await createCustomerFamilyAndConsent(journey);
    await createCharactersAndDuplicateChoices(journey);
    await createAndVerifyPhotoCharacter(journey);
    await exerciseVersionsLooksAndArchive(journey);
    await exerciseFamilyBoundary(journey);
    const interrupted = await cancelThenInterruptIntake(journey);
    await stopApp(running, "SIGKILL");
    running = await startApp(dataDir, port);
    await verifyRestart(journey, interrupted);
    await verifyLibraryAccessibility(page);
    expect(externalRequests).toEqual([]);
  } finally {
    if (running) await stopApp(running, "SIGTERM");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function createCustomerFamilyAndConsent(journey: Journey) {
  const { page, origin } = journey;
  await openLibrary(page, origin);
  await createCustomer(page, "عميل اصطناعي");
  await expect(page.getByText("PHOTO_CONSENT_NOT_RECORDED")).toBeVisible();
  await recordConsent(page, "موافقة غير ممنوحة", "رفض اصطناعي مسجّل");
  await expect(page.getByText("PHOTO_CONSENT_NOT_GRANTED")).toBeVisible();
  await recordConsent(page, "موافقة ممنوحة", "موافقة اصطناعية للاختبار");
  await expect(page.getByText("PHOTO_CONSENT_NOT_GRANTED")).toBeHidden();
  await createFamily(page, FAMILY_NAME);
  await createDescriptionCharacter(page, { name: "ليلى" });
  await expect(page.getByText("الطفل محور العائلة: ليلى")).toBeVisible();
  await renameFamily(page, FAMILY_NAME, RENAMED_FAMILY);
}

async function createCharactersAndDuplicateChoices(journey: Journey) {
  const { page } = journey;
  await createDescriptionCharacter(page, {
    name: "سارة",
    relationship: "الأخت",
  });
  await createDescriptionCharacter(page, {
    name: "سارة",
    relationship: "الأخت",
    duplicate: "open",
  });
  let snapshot = await getLibrary(journey.request, journey.origin);
  expect(charactersNamed(snapshot, "سارة")).toHaveLength(1);
  await createDescriptionCharacter(page, {
    name: "سارة",
    relationship: "الأخت",
    duplicate: "separate",
  });
  await createDescriptionCharacter(page, {
    name: "فلفل",
    relationship: "حيوان أليف",
  });
  snapshot = await getLibrary(journey.request, journey.origin);
  expect(charactersNamed(snapshot, "سارة")).toHaveLength(2);
  expect(
    charactersNamed(snapshot, "فلفل")[0]?.currentVersion.profile,
  ).toMatchObject({ relationship: { type: "pet" }, sourceMode: "description" });
}

async function createAndVerifyPhotoCharacter(journey: Journey) {
  const { page, request, origin, imagePath } = journey;
  await beginPhotoCharacter(page, "نور");
  const staged = await stageVisiblePhoto(page, imagePath);
  await expect(page.locator(`img[src="${staged.thumbnailUrl}"]`)).toBeVisible();
  await page.getByLabel("عدد الأشخاص الظاهرين").fill("2");
  await page.getByLabel("ما يحجب الوجه").fill("نظارة شمسية اصطناعية");
  await page.getByLabel("أشتبه في وجود مرشح ثقيل").check();
  const box = page.getByRole("button", { name: /إطار الشخص المقصود/ });
  await box.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByLabel("وضعت الإطار حول الشخص المقصود تحديدًا").check();
  await expectFullFrameMultiPersonRefused({
    request,
    origin,
    token: await getCsrfToken(request, origin),
    reservationToken: staged.reservationToken,
  });
  await commitVisiblePhoto(page);
  await expect(page.getByRole("heading", { name: "نور" })).toBeVisible();
  await verifySafeCommittedPhoto(journey);
}

async function stageVisiblePhoto(
  page: Page,
  imagePath: string,
): Promise<StagedPhoto> {
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith("/api/library/photo-intake/stage") &&
      item.request().method() === "POST",
  );
  await page.getByLabel(/ملف مرجع لـ/).setInputFiles(imagePath);
  await page.getByRole("button", { name: "فحص الصورة محليًا" }).click();
  const stagedResponse = await response;
  expect(stagedResponse.status()).toBe(200);
  const staged = (await stagedResponse.json()) as StagedPhoto;
  await expect(
    page.getByRole("heading", { name: "نتيجة الصورة" }),
  ).toBeVisible();
  return staged;
}

async function commitVisiblePhoto(page: Page): Promise<void> {
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith("/api/library/photo-intake/commit") &&
      item.request().method() === "POST",
  );
  const commit = page.getByRole("button", { name: "حفظ المرجع والنسخة معًا" });
  await expect(commit).toBeEnabled();
  await commit.click();
  expect((await response).status()).toBe(200);
}

async function verifySafeCommittedPhoto(journey: Journey) {
  const snapshot = await getLibrary(journey.request, journey.origin);
  const photoCharacter = charactersNamed(snapshot, "نور")[0];
  expect(photoCharacter?.currentVersion.profile).toMatchObject({
    sourceMode: "photo",
    referencePhotoIds: [expect.any(String)],
  });
  expect(snapshot.referencePhotos).toHaveLength(1);
  const photo = snapshot.referencePhotos[0];
  expect(photo?.quality.policyVersion).toBe("PhotoQualityPolicy/v1");
  expect(photo?.quality.observations).toMatchObject({
    peopleCount: 2,
    filterSuspected: true,
  });
  expect(photo?.quality.warnings.map((item) => item.code)).toEqual(
    expect.arrayContaining([
      "PHOTO_LIMITED_REFERENCES",
      "PHOTO_MULTIPLE_PEOPLE",
      "PHOTO_OBSTRUCTED",
      "PHOTO_FILTER_SUSPECTED",
    ]),
  );
  expect(JSON.stringify(photo)).not.toMatch(
    /originalAssetId|workingAssetId|providerAssetId|thumbnailAssetId/,
  );
  await verifyThumbnail(journey, photo?.thumbnailUrl ?? "");
  expect(await managedFileCount(join(journey.dataDir, "originals"))).toBe(1);
  expect(await managedFileCount(join(journey.dataDir, "assets"))).toBe(3);
}

async function verifyThumbnail(journey: Journey, thumbnailUrl: string) {
  expect(thumbnailUrl).toMatch(/^\/api\/library\/reference-photos\//);
  const response = await journey.request.get(
    `${journey.origin}${thumbnailUrl}`,
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/jpeg");
  expect(response.headers()["cache-control"]).toContain("no-store");
}

async function exerciseVersionsLooksAndArchive(journey: Journey) {
  const { page } = journey;
  await selectCharacter(page, "سارة");
  await page.getByRole("button", { name: /تحديث الملف الأساسي/ }).click();
  const age = page.getByLabel("العمر أو النطاق العمري");
  await age.fill("8 سنوات");
  await page.getByRole("button", { name: "حفظ كنسخة أساسية جديدة" }).click();
  await expect(age).toBeHidden();
  await createLook(page, "مظهر الحديقة", "فستان أخضر اصطناعي");
  await createLook(page, "مظهر الفضاء", "بدلة فضاء صفراء");
  const row = lookRow(page, "مظهر الفضاء");
  await row.getByRole("button", { name: "أرشفة المظهر" }).click();
  await expect(
    row.getByRole("button", { name: "استعادة المظهر" }),
  ).toBeVisible();
  await row.getByRole("button", { name: "استعادة المظهر" }).click();
  await selectCharacter(page, "فلفل");
  await page.getByRole("button", { name: "أرشفة الشخصية" }).click();
  await expect(
    page.getByRole("button", { name: "استعادة الشخصية" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "استعادة الشخصية" }).click();
}

async function exerciseFamilyBoundary(journey: Journey) {
  const before = await getLibrary(journey.request, journey.origin);
  const firstFamily = familyNamed(before, RENAMED_FAMILY);
  const anchorId = firstFamily?.anchorCharacterId;
  expect(anchorId).toEqual(expect.any(String));
  await createFamily(journey.page, "عائلة الحدود الثانية");
  const after = await getLibrary(journey.request, journey.origin);
  const secondFamily = familyNamed(after, "عائلة الحدود الثانية");
  await expectCrossFamilyRefused({
    request: journey.request,
    origin: journey.origin,
    token: await getCsrfToken(journey.request, journey.origin),
    familyId: secondFamily?.id ?? "",
    characterId: anchorId ?? "",
    image: await readFile(journey.imagePath),
  });
  await selectFamily(journey.page, RENAMED_FAMILY);
  await journey.page.getByRole("button", { name: "أرشفة العائلة" }).click();
  await expect(
    journey.page.getByRole("button", { name: "استعادة العائلة" }),
  ).toBeVisible();
  await journey.page.getByRole("button", { name: "استعادة العائلة" }).click();
}

async function cancelThenInterruptIntake(journey: Journey) {
  const { page, imagePath, dataDir } = journey;
  await selectCharacter(page, "نور");
  await openExistingPhotoIntake(page);
  await stageVisiblePhoto(page, imagePath);
  const cancelResponse = page.waitForResponse((item) =>
    item.url().endsWith("/api/library/photo-intake/cancel"),
  );
  await page.getByRole("button", { name: "إلغاء الصورة" }).click();
  expect((await cancelResponse).status()).toBe(204);
  await expect(page.getByText("مراجع موصى بها")).toBeHidden();
  await expectFileCounts(dataDir);
  await openExistingPhotoIntake(page);
  const interrupted = await stageVisiblePhoto(page, imagePath);
  await expectFileCounts(dataDir);
  return interrupted;
}

async function openExistingPhotoIntake(page: Page): Promise<void> {
  await page.getByRole("button", { name: "إضافة صورة مرجعية" }).click();
  await expect(page.getByText("مراجع موصى بها")).toBeVisible();
}

async function expectFileCounts(dataDir: string): Promise<void> {
  expect(await managedFileCount(join(dataDir, "originals"))).toBe(1);
  expect(await managedFileCount(join(dataDir, "assets"))).toBe(3);
}

async function verifyRestart(journey: Journey, interrupted: StagedPhoto) {
  const { page, request, origin, dataDir } = journey;
  await page.getByRole("button", { name: "إلغاء الصورة" }).click();
  await expect(page.getByText(/انتهت جلسة هذا التبويب/)).toBeVisible();
  const token = await getCsrfToken(request, origin);
  const staleReservation = await request.post(
    `${origin}/api/library/photo-intake/commit`,
    {
      headers: mutationHeaders(origin, token),
      data: interruptedCommit(interrupted.reservationToken),
    },
  );
  expect(staleReservation.status()).toBe(404);
  await expect(staleReservation.json()).resolves.toEqual({
    code: "PHOTO_RESERVATION_NOT_FOUND",
  });
  await expectFileCounts(dataDir);
  await openLibrary(page, origin);
  await expect(
    page.getByRole("heading", { name: "نتيجة الصورة" }),
  ).toBeHidden();
  await verifyPersistedLibrary(journey);
}

async function verifyPersistedLibrary(journey: Journey) {
  const snapshot = await getLibrary(journey.request, journey.origin);
  expect(snapshot.customers[0]).toMatchObject({
    name: "عميل اصطناعي",
    consent: { granted: true, note: "موافقة اصطناعية للاختبار" },
  });
  expect(familyNamed(snapshot, RENAMED_FAMILY)).toMatchObject({
    status: "active",
    anchorCharacterId: expect.any(String),
  });
  expect(charactersNamed(snapshot, "سارة")).toHaveLength(2);
  expect(charactersNamed(snapshot, "فلفل")[0]?.status).toBe("active");
  const versioned = charactersNamed(snapshot, "سارة").find(
    (item) => item.versionCount === 2,
  );
  expect(versioned?.currentVersion.profile).toMatchObject({
    ageOrRange: "8 سنوات",
  });
  expect(
    snapshot.looks.filter((look) => look.characterId === versioned?.id),
  ).toHaveLength(2);
  expect(snapshot.looks.every((look) => look.status === "active")).toBe(true);
  await verifySafeCommittedPhoto(journey);
}

async function verifyLibraryAccessibility(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectAccessible(page);
  for (const size of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ])
    await expectViewportFit(page, size);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectKeyboardFocus(page);
  expect(await page.locator("body").innerText()).not.toMatch(/[٠-٩]/);
}

function interruptedCommit(reservationToken: string) {
  return {
    reservationToken,
    subjectSelection: { x: 0.2, y: 0.15, width: 0.5, height: 0.65 },
    subjectSelectionConfirmed: true,
    observations: { peopleCount: 1 },
    duplicateDecision: { action: "create_separate" },
  };
}

function mutationHeaders(origin: string, token: string) {
  return {
    origin,
    "x-hekayati-csrf": token,
    "content-type": "application/json",
  };
}

function charactersNamed(snapshot: LibrarySnapshot, name: string) {
  return snapshot.characters.filter(
    (character) => character.currentVersion.profile.name === name,
  );
}

function familyNamed(snapshot: LibrarySnapshot, name: string) {
  return snapshot.families.find((family) => family.name === name);
}
