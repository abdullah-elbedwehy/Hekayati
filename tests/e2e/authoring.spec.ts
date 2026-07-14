import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import {
  expectAccessible,
  expectViewportFit,
  getCsrfToken,
  getLibrary,
  monitorExternalRequests,
} from "./support/library-fixture.js";
import {
  createCustomer,
  createDescriptionCharacter,
  createFamily,
  createLook,
  openLibrary,
} from "./support/library-ui.js";
import {
  reservePort,
  startApp,
  stopApp,
  type RunningApp,
} from "./support/running-app.js";

test.setTimeout(150_000);

test("provider-free story authoring survives rename, template lifecycle, and restart", async ({
  page,
  request,
}) => {
  const root = await mkdtemp(join(tmpdir(), "hekayati-e2e-authoring-"));
  const dataDir = join(root, "data");
  const port = await reservePort();
  const external = monitorExternalRequests(page);
  let running: RunningApp | null = null;
  try {
    running = await startApp(dataDir, port);
    await createAuthoringFamily(page, running.origin);
    const target = await createTargetFamily(request, running.origin);
    const created = await createProjectInUi(page);
    await editProjectConfiguration(page);
    await authorFirstScene(page);
    await renameDuplicateFriend(page);
    await verifyRenameAndPagePlan(page, "عائلة المؤلف");
    await exerciseTemplateLifecycle(page);
    await exerciseOverrideIsolation(page, request, running.origin, created);
    await exerciseEmptyGroupAndPagePlans(request, running.origin, target);
    const completed = await completeRemainingScenes(
      request,
      running.origin,
      created,
    );
    await reopenProject(page, "عائلة المؤلف");
    await expect(page.getByText("الحكاية مكتملة")).toBeVisible();
    const extracted = await extractCompletedTemplateInUi(page, completed);
    await verifyCompletedStoryCopies(
      request,
      running.origin,
      completed,
      target.familyId,
      extracted,
    );
    await verifyAuthoringAccessibility(page);
    await stopApp(running, "SIGKILL");
    running = await startApp(dataDir, port);
    await openProjects(page, running.origin, "عائلة المؤلف");
    await expect(page.getByText("الحكاية مكتملة")).toBeVisible();
    await expect(page.locator(".page-map .page-tile")).toHaveCount(16);
    expect(external).toEqual([]);
  } finally {
    if (running) await stopApp(running, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

async function createAuthoringFamily(page: Page, origin: string) {
  await openLibrary(page, origin);
  await createCustomer(page, "عميل التأليف الاصطناعي");
  await createFamily(page, "عائلة المؤلف");
  await createDescriptionCharacter(page, { name: "أحمد" });
  await createDescriptionCharacter(page, {
    name: "أَحْمَد",
    relationship: "صديق أو صديقة",
  });
  await createLook(page, "ملابس الرحلة", "بدلة رحلة زرقاء");
}

async function createProjectInUi(page: Page) {
  await page
    .getByRole("button", { name: "المشاريع والقصص", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "المشاريع والقصص" }),
  ).toBeVisible();
  await page.getByLabel("العائلة").selectOption({ label: "عائلة المؤلف" });
  await expect(
    page.getByRole("heading", { name: "مشروع كتاب جديد" }),
  ).toBeVisible();
  await page.getByLabel("عنوان المشروع").fill("رحلة أحمد الآمنة");
  const participants = page.locator(".participant-choice input");
  await expect(participants).toHaveCount(2);
  await participants.nth(1).check();
  await page.getByLabel("الدور السردي لـ أَحْمَد").fill("الصديق المستكشف");
  await page.getByLabel("مظهر أَحْمَد").selectOption({ label: "ملابس الرحلة" });
  const response = page.waitForResponse(
    (item) =>
      item.url().includes("/api/authoring/families/") &&
      item.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "إنشاء المشروع ومشاهد القصة" })
    .click();
  const createdResponse = await response;
  expect(createdResponse.status()).toBe(200);
  const created = await createdResponse.json();
  await expect(
    page.getByRole("heading", { name: "رحلة أحمد الآمنة" }),
  ).toBeVisible();
  await expect(page.locator(".page-map .page-tile")).toHaveCount(16);
  return created as AuthoringWorkspace;
}

async function authorFirstScene(page: Page) {
  const mentionEntry = page.getByLabel("ابحث أو الصق إشارة تبدأ بـ @");
  await mentionEntry.fill("@أح");
  await page.getByRole("button", { name: "إضافة النص أو الإشارة" }).click();
  const unresolved = page.locator(".mention-token--unresolved");
  await expect(unresolved).toContainText("@أح");
  await unresolved.getByRole("button", { name: /حذف/ }).click();
  await mentionEntry.fill("أَحْمَد");
  await expect(page.locator(".mention-option")).toHaveCount(2);
  await page.locator(".mention-option").first().click();
  await page.getByLabel("الفعل").fill("بيستكشف بثقة");
  await page.getByLabel("المشاعر").fill("متحمس");
  await page.getByLabel("هدف المشهد").fill("بداية الرحلة");
  await page.getByLabel("وصف المشهد").fill("البطل يستعد في مكان آمن");
  await page
    .getByLabel("النص المصري الظاهر في الكتاب")
    .fill("كان أحمد جاهز للمغامرة.");
  await page.getByLabel("المكان").fill("غرفة مضيئة");
  await page.getByLabel("وقت اليوم").fill("صباح");
  await page.getByLabel("التكوين").fill("البطل في المنتصف");
  await page.getByLabel("الكاميرا والإطار").fill("لقطة متوسطة");
  const response = page.waitForResponse(
    (item) =>
      item.url().includes("/scenes/1") && item.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "حفظ نسخة المشهد" }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText("مكتمل يدويًا")).toBeVisible();
}

async function editProjectConfiguration(page: Page) {
  const configuration = page.getByRole("form", {
    name: "نصوص الكتاب والإعداد",
  });
  await configuration
    .locator('textarea[name="dedicationText"]')
    .fill("إهداء خاص لا يخرج من المشروع");
  await configuration
    .locator('input[name="selectedNarrationPercent"]')
    .fill("61");
  const response = page.waitForResponse(
    (item) =>
      item.url().includes("/api/authoring/projects/") &&
      item.request().method() === "PATCH" &&
      !item.url().includes("/scenes/"),
  );
  await page.getByRole("button", { name: "حفظ نسخة إعداد جديدة" }).click();
  expect((await response).status()).toBe(200);
  await expect(page.locator(".balance-meter")).toContainText("61%");
}

async function renameDuplicateFriend(page: Page) {
  await page
    .getByRole("button", { name: "مكتبة العائلات", exact: true })
    .click();
  const duplicates = page
    .locator(".character-rail button")
    .filter({ hasText: "أَحْمَد" });
  await expect(duplicates).toHaveCount(1);
  await duplicates.click();
  await page.getByRole("button", { name: /تحديث الملف الأساسي/ }).click();
  await page.getByLabel("الاسم", { exact: true }).fill("علي");
  await page.getByRole("button", { name: "حفظ كنسخة أساسية جديدة" }).click();
  await expect(page.getByRole("heading", { name: "علي" })).toBeVisible();
}

async function verifyRenameAndPagePlan(page: Page, familyName: string) {
  await page
    .getByRole("button", { name: "المشاريع والقصص", exact: true })
    .click();
  await page.getByLabel("العائلة").selectOption({ label: familyName });
  await expect(
    page.locator(".mention-option").filter({ hasText: "علي" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "تغيير إلى 24 صفحة" }).click();
  await expect(
    page.getByRole("heading", { name: "خطة 16 ← 24 صفحة" }),
  ).toBeVisible();
  await expect(page.getByText("إضافة", { exact: true })).toHaveCount(8);
  await page.getByRole("button", { name: "إلغاء", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "خطة 16 ← 24 صفحة" }),
  ).toBeHidden();
}

async function exerciseTemplateLifecycle(page: Page) {
  const table = page.locator(".template-row");
  const manager = page.getByRole("region", { name: "إدارة القوالب" });
  await expect(table).toHaveCount(7);
  const row = page
    .locator(".template-row")
    .filter({ hasText: "مغامرة الفضاء" });
  await row.getByRole("button", { name: "تعطيل للاختيار" }).click();
  await expect(row.getByText("◼ معطّل")).toBeVisible();
  await row.getByRole("button", { name: "استعادة للاختيار" }).click();
  await expect(row.getByText("● متاح")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "رحلة أحمد الآمنة" }),
  ).toBeVisible();
  await row.getByRole("button", { name: "إنشاء نسخة" }).click();
  await expect(table).toHaveCount(8);
  let draft = manager.locator("form.template-draft-form");
  await draft.locator('input[name="templateName"]').fill("قالب واجهة جديد");
  await draft
    .locator('textarea[name="templatePremise"]')
    .fill("بنية اصطناعية قابلة لإعادة الاستخدام");
  await draft.locator('button[type="submit"]').click();
  await expect(table).toHaveCount(9);
  await manager.locator("select").first().selectOption("edit");
  await manager
    .locator("select")
    .nth(1)
    .selectOption({ label: "قالب واجهة جديد" });
  draft = manager.locator("form.template-draft-form");
  await draft.locator('input[name="templateName"]').fill("قالب واجهة محرر");
  await draft.locator('button[type="submit"]').click();
  await expect(
    page.locator(".template-row").filter({ hasText: "قالب واجهة محرر" }),
  ).toBeVisible();
}

async function createTargetFamily(
  request: APIRequestContext,
  origin: string,
): Promise<{ familyId: string; characterId: string }> {
  const token = await getCsrfToken(request, origin);
  const customer = await postJson<{ id: string }>(
    request,
    origin,
    token,
    "/api/library/customers",
    {
      name: "عميل الخصوصية الاصطناعي",
      whatsapp: "+201000000001",
      notes: "بيانات اصطناعية",
    },
  );
  const family = await postJson<{ id: string }>(
    request,
    origin,
    token,
    `/api/library/customers/${customer.id}/families`,
    { name: "عائلة الخصوصية" },
  );
  const profile = targetCharacterProfile();
  const preflight = await postJson<{ preflightToken: string }>(
    request,
    origin,
    token,
    `/api/library/families/${family.id}/characters/preflight`,
    { profile },
  );
  const character = await postJson<{ id: string }>(
    request,
    origin,
    token,
    `/api/library/families/${family.id}/characters`,
    { profile, preflightToken: preflight.preflightToken },
  );
  return { familyId: family.id, characterId: character.id };
}

async function exerciseOverrideIsolation(
  page: Page,
  request: APIRequestContext,
  origin: string,
  initial: AuthoringWorkspace,
) {
  const token = await getCsrfToken(request, origin);
  const workspace = await getWorkspace(request, origin, initial);
  const friendId = workspace.version.storyConfig.participants.find(
    ({ characterId }) =>
      characterId !== workspace.version.storyConfig.mainChildId,
  )!.characterId;
  const before = await getLibrary(request, origin);
  const beforeCharacter = before.characters.find(({ id }) => id === friendId);
  const command = {
    characterId: friendId,
    clothing: "بدلة خاصة بهذا المشروع",
    appearanceOverrides: { scarf: "أخضر" },
  };
  const stale = await postJson<{ code: string }>(
    request,
    origin,
    token,
    `/api/authoring/projects/${workspace.project.id}/overrides?familyId=${workspace.project.familyId}`,
    { ...command, expectedProjectVersionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    409,
  );
  expect(stale.code).toBe("PROJECT_VERSION_CONFLICT");
  const override = page.getByRole("region", { name: "تغيير غير مشترك" });
  await override
    .locator('select[name="characterId"]')
    .selectOption({ label: "علي" });
  await override
    .locator('input[name="projectClothing"]')
    .fill(command.clothing);
  await override.locator('input[name="appearanceNotes"]').fill("وشاح أخضر");
  const changedResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/overrides") &&
      response.request().method() === "POST",
  );
  await override
    .getByRole("button", { name: "حفظ تغيير لهذا المشروع فقط" })
    .click();
  const changed = (await (await changedResponse).json()) as OverrideResult;
  expect(changed.event.matrixRow).toBe("IM-04");
  expect(changed.projectVersion.id).not.toBe(workspace.version.id);
  await expect(page.getByText("نسخة مشروع مستقلة")).toBeVisible();
  const after = await getLibrary(request, origin);
  expect(after.characters.find(({ id }) => id === friendId)).toEqual(
    beforeCharacter,
  );
  const repinned = await getWorkspace(request, origin, initial);
  expect(repinned.version.storyConfig.templateVersionId).toBe(
    initial.version.storyConfig.templateVersionId,
  );
}

async function exerciseEmptyGroupAndPagePlans(
  request: APIRequestContext,
  origin: string,
  target: { familyId: string; characterId: string },
) {
  const token = await getCsrfToken(request, origin);
  let workspace = await postJson<AuthoringWorkspace>(
    request,
    origin,
    token,
    `/api/authoring/families/${target.familyId}/projects`,
    targetProjectInput(target.characterId),
  );
  const scene = workspace.scenes[0];
  workspace = await patchJson<AuthoringWorkspace>(
    request,
    origin,
    token,
    `/api/authoring/projects/${workspace.project.id}/scenes/1?familyId=${target.familyId}`,
    {
      expectedStoryVersionId: workspace.storyVersion.id,
      expectedSceneVersionId: scene.version.id,
      content: {
        ...completeScene(target.characterId, 1),
        documentSegments: [{ type: "group", groupKey: "friends" }],
      },
    },
  );
  await expectEmptyGroupBlock(request, origin, token, workspace, target);
  await expectBidirectionalPagePlans(request, origin, token, workspace);
}

async function expectEmptyGroupBlock(
  request: APIRequestContext,
  origin: string,
  token: string,
  workspace: AuthoringWorkspace,
  target: { familyId: string; characterId: string },
) {
  const blocked = await postJson<{ code: string }>(
    request,
    origin,
    token,
    `/api/authoring/projects/${workspace.project.id}/scenes/1/compile?familyId=${target.familyId}`,
    {
      selectedParticipantIds: [target.characterId],
      capability: { mode: "mock_unlimited" },
      acknowledgements: { reconciliation: true, capacity: false },
    },
    422,
  );
  expect(blocked.code).toBe("MENTION_GROUP_EMPTY");
}

async function expectBidirectionalPagePlans(
  request: APIRequestContext,
  origin: string,
  token: string,
  workspace: AuthoringWorkspace,
) {
  const route = `/api/authoring/projects/${workspace.project.id}/page-count`;
  const before = await getWorkspace(request, origin, workspace);
  const expand = await postJson<PagePlan>(
    request,
    origin,
    token,
    `${route}/preflight?familyId=${workspace.project.familyId}`,
    { to: 24 },
  );
  const afterPreflight = await getWorkspace(request, origin, workspace);
  expect(afterPreflight.version.id).toBe(before.version.id);
  expect(afterPreflight.storyVersion.id).toBe(before.storyVersion.id);
  const expanded = await postJson<AuthoringWorkspace>(
    request,
    origin,
    token,
    `${route}/confirm?familyId=${workspace.project.familyId}`,
    expand,
  );
  expect(expanded.scenes).toHaveLength(20);
  const shrink = await postJson<PagePlan>(
    request,
    origin,
    token,
    `${route}/preflight?familyId=${workspace.project.familyId}`,
    { to: 16 },
  );
  expect(shrink.operations.some(({ type }) => type === "merge")).toBe(true);
}

async function completeRemainingScenes(
  request: APIRequestContext,
  origin: string,
  initial: AuthoringWorkspace,
): Promise<AuthoringWorkspace> {
  const token = await getCsrfToken(request, origin);
  let workspace = (await request
    .get(
      `${origin}/api/authoring/projects/${initial.project.id}?familyId=${initial.project.familyId}`,
    )
    .then((response) => response.json())) as AuthoringWorkspace;
  for (const scene of workspace.scenes.filter(
    (item) => item.scene.storyPageIndex > 1,
  )) {
    const current = workspace.scenes.find(
      (item) => item.scene.id === scene.scene.id,
    )!;
    const response = await request.patch(
      `${origin}/api/authoring/projects/${workspace.project.id}/scenes/${scene.scene.storyPageIndex}?familyId=${workspace.project.familyId}`,
      {
        headers: { origin, "x-hekayati-csrf": token },
        data: {
          expectedStoryVersionId: workspace.storyVersion.id,
          expectedSceneVersionId: current.version.id,
          content: completeScene(
            workspace.version.storyConfig.mainChildId,
            scene.scene.storyPageIndex,
          ),
        },
      },
    );
    expect(response.status()).toBe(200);
    workspace = (await response.json()) as AuthoringWorkspace;
  }
  expect(workspace.story.status).toBe("complete");
  return workspace;
}

async function verifyCompletedStoryCopies(
  request: APIRequestContext,
  origin: string,
  source: AuthoringWorkspace,
  targetFamilyId: string,
  extracted: unknown,
) {
  const token = await getCsrfToken(request, origin);
  const base = `/api/authoring/projects/${source.project.id}`;
  const scoped = `familyId=${source.project.familyId}`;
  const crossFamily = await postJson<{ status: string }>(
    request,
    origin,
    token,
    `${base}/cross-family-draft?${scoped}`,
    { targetFamilyId },
  );
  expect(crossFamily.status).toBe("role_remap_required");
  assertNoSourceIdentity(extracted, source);
  assertNoSourceIdentity(crossFamily, source);
  const duplicate = await postJson<AuthoringWorkspace>(
    request,
    origin,
    token,
    `${base}/duplicate-same-family?${scoped}`,
    {
      expectedProjectVersionId: source.version.id,
      expectedStoryVersionId: source.storyVersion.id,
      title: "نسخة عائلية آمنة",
    },
  );
  expect(duplicate.project.id).not.toBe(source.project.id);
  expect(duplicate.story.status).toBe("complete");
  expect(participantPins(duplicate)).toEqual(participantPins(source));
  const unchanged = await getWorkspace(request, origin, source);
  expect(unchanged.version.id).toBe(source.version.id);
  expect(unchanged.storyVersion.id).toBe(source.storyVersion.id);
}

async function extractCompletedTemplateInUi(
  page: Page,
  source: AuthoringWorkspace,
): Promise<unknown> {
  const extraction = page.locator("form.template-extraction");
  await extraction
    .locator('input[name="extractName"]')
    .fill("قالب رحلة واجهة آمنة");
  const response = page.waitForResponse(
    (item) =>
      item.url().includes("/extract-template") &&
      item.request().method() === "POST",
  );
  await extraction.locator('button[type="submit"]').click();
  const extracted = await (await response).json();
  assertNoSourceIdentity(extracted, source);
  return extracted;
}

function assertNoSourceIdentity(value: unknown, source: AuthoringWorkspace) {
  const serialized = JSON.stringify(value);
  const identifiers = [
    source.project.customerId,
    source.project.familyId,
    source.project.id,
    source.version.id,
    source.story.id,
    source.storyVersion.id,
    ...source.version.storyConfig.participants.flatMap((participant) => [
      participant.characterId,
      participant.characterVersionId,
    ]),
    ...source.scenes.flatMap(({ scene, version }) => [scene.id, version.id]),
  ];
  for (const identifier of identifiers)
    expect(serialized).not.toContain(identifier);
  expect(serialized).not.toContain(source.version.storyConfig.dedicationText);
  expect(serialized).not.toContain(source.version.storyConfig.customNotes);
  expect(serialized).not.toContain("أحمد");
  expect(serialized).not.toContain("علي");
}

function participantPins(workspace: AuthoringWorkspace) {
  return workspace.version.storyConfig.participants.map(
    ({ characterId, characterVersionId }) => ({
      characterId,
      characterVersionId,
    }),
  );
}

async function getWorkspace(
  request: APIRequestContext,
  origin: string,
  project: AuthoringWorkspace,
): Promise<AuthoringWorkspace> {
  const response = await request.get(
    `${origin}/api/authoring/projects/${project.project.id}?familyId=${project.project.familyId}`,
  );
  expect(response.status()).toBe(200);
  return response.json() as Promise<AuthoringWorkspace>;
}

async function postJson<T>(
  request: APIRequestContext,
  origin: string,
  token: string,
  path: string,
  data: unknown,
  expectedStatus = 200,
): Promise<T> {
  const response = await request.post(`${origin}${path}`, {
    headers: { origin, "x-hekayati-csrf": token },
    data,
  });
  expect(response.status()).toBe(expectedStatus);
  return response.json() as Promise<T>;
}

async function patchJson<T>(
  request: APIRequestContext,
  origin: string,
  token: string,
  path: string,
  data: unknown,
): Promise<T> {
  const response = await request.patch(`${origin}${path}`, {
    headers: { origin, "x-hekayati-csrf": token },
    data,
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<T>;
}

async function reopenProject(page: Page, familyName: string) {
  const navigation = page.getByRole("navigation");
  await navigation
    .getByRole("button", { name: "البداية", exact: true })
    .click();
  await navigation
    .getByRole("button", { name: "المشاريع والقصص", exact: true })
    .click();
  await page
    .getByRole("region", { name: "اختيار عائلة المشروع" })
    .locator("select")
    .selectOption({ label: familyName });
}

async function openProjects(page: Page, origin: string, familyName: string) {
  await page.goto(origin);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "المشاريع والقصص", exact: true })
    .click();
  await page
    .getByRole("region", { name: "اختيار عائلة المشروع" })
    .locator("select")
    .selectOption({ label: familyName });
  await expect(
    page.getByRole("heading", { name: "رحلة أحمد الآمنة" }),
  ).toBeVisible();
}

async function verifyAuthoringAccessibility(page: Page) {
  await expectAccessible(page);
  await expectViewportFit(page, { width: 390, height: 844 });
  await expectViewportFit(page, { width: 1440, height: 900 });
  await expectViewportFit(page, { width: 1920, height: 1080 });
}

function completeScene(characterId: string, index: number) {
  return {
    purpose: `لحظة ${index}`,
    description: "مشهد آمن وواضح",
    documentSegments: [
      {
        type: "mention",
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

function targetProjectInput(mainChildId: string) {
  return {
    title: "مشروع اختبار المجموعات",
    mainChildId,
    participants: [{ characterId: mainChildId, narrativeRole: "البطل" }],
    occasion: "اختبار اصطناعي",
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

function targetCharacterProfile() {
  return {
    name: "نور",
    nickname: null,
    relationship: { type: "main_child" },
    appearanceDescription: "طفلة اصطناعية",
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
  };
}

interface AuthoringWorkspace {
  project: { id: string; customerId: string; familyId: string };
  version: {
    id: string;
    storyConfig: {
      title: string;
      mainChildId: string;
      dedicationText: string;
      customNotes: string;
      templateVersionId: string | null;
      participants: Array<{
        characterId: string;
        characterVersionId: string;
      }>;
    };
  };
  story: { id: string; status: string };
  storyVersion: { id: string };
  scenes: Array<{
    scene: { id: string; storyPageIndex: number };
    version: { id: string };
  }>;
}

interface OverrideResult {
  projectVersion: { id: string };
  event: { matrixRow: string };
}

interface PagePlan {
  input: Record<string, unknown>;
  operations: Array<{ type: string }>;
  hash: string;
}
