import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

import {
  expectAccessible,
  expectViewportFit,
  monitorExternalRequests,
} from "./support/library-fixture.js";
import {
  reservePort,
  startApp,
  stopApp,
  type RunningApp,
} from "./support/running-app.js";

test.setTimeout(150_000);

test("Arabic creative review closes every owner workflow at three widths", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "hekayati-e2e-creative-"));
  const port = await reservePort();
  const external = monitorExternalRequests(page);
  let running: RunningApp | null = null;
  try {
    running = await startApp(join(root, "data"), port, {
      entryScript: "tests/fixtures/start-creative-ui-app.ts",
    });
    await openCreative(page, running.origin);
    await requestThenApproveSheet(page);
    await generateBook(page);
    await verifyConsistencyAndHistory(page);
    await acknowledgeBlockFinding(page);
    await verifyResponsiveAccessibleUi(page);
    expect(external).toEqual([]);
  } finally {
    if (running) await stopApp(running, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

test("policy and capacity decisions require explicit sequential confirmation", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "hekayati-e2e-policy-"));
  const port = await reservePort();
  const requests: SheetStartRequest[] = [];
  let running: RunningApp | null = null;
  try {
    running = await startApp(join(root, "data"), port, {
      entryScript: "tests/fixtures/start-creative-ui-app.ts",
    });
    await installSequentialPolicyChallenges(page, requests);
    await openCreative(page, running.origin);
    await page.getByRole("button", { name: "إنشاء الورقة" }).click();
    await expectPolicyDecision(page);
    await verifyPolicyDecisionAccessibility(page);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.confirmations?.prompt).toBeUndefined();
    expect(requests[0]?.confirmations?.capacity).toBeUndefined();
    await page.getByRole("button", { name: "ليس الآن" }).click();
    await expect(
      page.getByRole("heading", { name: "تحويل الوصف إلى أسلوب أصلي" }),
    ).toBeHidden();
    expect(requests).toHaveLength(1);
    await page.getByRole("button", { name: "إنشاء الورقة" }).click();
    await expectPolicyDecision(page);
    await page.getByRole("button", { name: "أوافق وأتابع" }).click();
    await expectCapacityDecision(page);
    expect(requests[2]?.confirmations?.prompt?.confirmed).toBe(true);
    expect(requests[2]?.confirmations?.capacity).toBeUndefined();
    await page.getByRole("button", { name: "أوافق وأتابع" }).click();
    expect(requests[3]?.confirmations?.prompt?.confirmed).toBe(true);
    expect(requests[3]?.confirmations?.capacity?.confirmed).toBe(true);
    await expect(page.getByText("تنتظر الاعتماد")).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    if (running) await stopApp(running, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

interface SheetStartRequest {
  confirmations?: {
    prompt?: { confirmed?: boolean };
    capacity?: { confirmed?: boolean };
  };
}

async function installSequentialPolicyChallenges(
  page: Page,
  requests: SheetStartRequest[],
) {
  await page.route(
    /\/api\/creative\/projects\/[^/]+\/sheets(?:\?|$)/,
    async (route) => {
      const body = route.request().postDataJSON() as SheetStartRequest;
      requests.push(body);
      if (!body.confirmations?.prompt) {
        await fulfillPolicyChallenge(route);
        return;
      }
      if (!body.confirmations.capacity) {
        await fulfillCapacityChallenge(route);
        return;
      }
      await route.continue();
    },
  );
}

async function fulfillPolicyChallenge(route: Route) {
  await route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({
      code: "CREATIVE_POLICY_CONFIRMATION_REQUIRED",
      details: {
        policyVersion: "prompt-policy-v1",
        bindingHash: "a".repeat(64),
        matchedCategories: ["franchise_trademark"],
        alternativePrompt: "RAW_SYNTHETIC_ALTERNATIVE_MUST_NOT_RENDER",
      },
    }),
  });
}

async function fulfillCapacityChallenge(route: Route) {
  await route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({
      code: "CREATIVE_CAPACITY_CONFIRMATION_REQUIRED",
      details: {
        bindingHash: "b".repeat(64),
        maxReferenceImages: 1,
        reliableCharacterCount: 1,
        participantExcess: false,
        counts: [{ characterId: "synthetic", requested: 2, selected: 1 }],
      },
    }),
  });
}

async function expectPolicyDecision(page: Page) {
  await expect(
    page.getByRole("region", { name: "تحويل الوصف إلى أسلوب أصلي" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "تحويل الوصف إلى أسلوب أصلي" }),
  ).toBeVisible();
  await expect(page.getByText("اسم علامة أو شخصية محمية")).toBeVisible();
  await expect(
    page.getByText("RAW_SYNTHETIC_ALTERNATIVE_MUST_NOT_RENDER"),
  ).toHaveCount(0);
  const approve = page.getByRole("button", { name: "أوافق وأتابع" });
  await expect(approve).toBeFocused();
  expect(
    await approve.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  expect(
    await approve.evaluate((element) =>
      parseFloat(getComputedStyle(element).outlineWidth),
    ),
  ).toBeGreaterThanOrEqual(2);
}

async function verifyPolicyDecisionAccessibility(page: Page) {
  await expectAccessible(page);
  await expectViewportFit(page, { width: 390, height: 844 });
  await expectViewportFit(page, { width: 1440, height: 900 });
}

async function expectCapacityDecision(page: Page) {
  await expect(
    page.getByRole("heading", { name: "اعتماد توزيع مراجع الصور" }),
  ).toBeVisible();
  await expect(page.getByText("1 من 2")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "أوافق وأتابع" }),
  ).toBeFocused();
}

async function openCreative(page: Page, origin: string) {
  await page.goto(origin);
  const acknowledge = page.getByRole("button", { name: "فهمت" });
  if (await acknowledge.isVisible()) {
    await acknowledge.click();
    await expect(acknowledge).toBeHidden();
  }
  await page
    .getByRole("button", { name: "الإبداع والمراجعة", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "الإبداع والمراجعة" }),
  ).toBeVisible();
  await page.getByLabel("العائلة").selectOption({ label: "عائلة اصطناعية" });
  await page
    .getByLabel("المشروع")
    .selectOption({ label: "رحلة نور الاصطناعية" });
  await expect(
    page.getByRole("heading", { name: "أوراق اعتماد الشخصيات" }),
  ).toBeVisible();
}

async function requestThenApproveSheet(page: Page) {
  await page.getByRole("button", { name: "إنشاء الورقة" }).click();
  await expect(page.getByText("تنتظر الاعتماد")).toBeVisible({
    timeout: 30_000,
  });
  await page.locator(".sheet-change-request summary").click();
  await page.getByLabel("ما المطلوب تغييره؟").fill("تعديل اصطناعي للشعر");
  const changed = page.waitForResponse(
    (response) =>
      response.url().includes("/change-request") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "إرسال الطلب وإنشاء محاولة لاحقة" })
    .click();
  expect((await changed).status()).toBe(200);
  await expect(page.getByText("قيد التوليد", { exact: true })).toBeVisible();
  await expect(page.getByText("تنتظر الاعتماد")).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByLabel("ملاحظات قرار الاعتماد")
    .fill("اعتماد اصطناعي بعد المراجعة");
  await page.getByRole("button", { name: "اعتماد الورقة" }).click();
  await expect(page.getByText("جاهزة للحكاية")).toBeVisible();
}

async function generateBook(page: Page) {
  await page.getByRole("button", { name: "بدء توليد الكتاب" }).click();
  await expect(
    page.getByRole("heading", { name: "مراجعة الصفحات" }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".page-frame")).toHaveCount(12);
  await expectImageLoaded(page.locator(".page-proof__image img"));
  await expect(page.locator(".sheet-reference-card img")).toHaveCount(3);
  await expectImageLoaded(page.locator(".sheet-reference-card img").first());
}

async function verifyConsistencyAndHistory(page: Page) {
  const zoom = page.getByLabel("التكبير");
  await zoom.focus();
  const before = Number(await zoom.inputValue());
  await page.keyboard.press("ArrowRight");
  expect(Number(await zoom.inputValue())).not.toBe(before);
  const focusStyle = await zoom.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineWidth, shadow: style.boxShadow };
  });
  expect(
    parseFloat(focusStyle.outline) > 0 || focusStyle.shadow !== "none",
  ).toBe(true);

  const regeneration = page.waitForResponse(
    (response) =>
      response.url().includes("/regenerate-illustration") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "إعادة الرسم لهذه الصفحة فقط" })
    .click();
  const regenerationResponse = await regeneration;
  expect(regenerationResponse.status()).toBe(200);
  const history = page.locator(".version-history summary");
  await expect(history).toContainText("2 رسم", { timeout: 30_000 });
  await history.click();
  const priorDrawing = page
    .locator(".illustration-version button:not(:disabled)")
    .first();
  await expect(priorDrawing).toBeEnabled();
  await priorDrawing.click();
  await expect(page.locator(".version-history summary")).toContainText("3 رسم");
}

async function acknowledgeBlockFinding(page: Page) {
  await expect(page.getByText("تتطلب إقرار المشغّل")).toBeVisible();
  await page
    .getByLabel("سبب قبول المتابعة")
    .fill("راجعه المشغّل وتأكد من سلامته");
  await page.getByRole("button", { name: "إقرار الملاحظة المانعة" }).click();
  await expect(page.getByText("تم الإقرار بواسطة المشغّل")).toBeVisible();
}

async function verifyResponsiveAccessibleUi(page: Page) {
  await expectAccessible(page);
  for (const size of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ])
    await expectViewportFit(page, size);
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
}

async function expectImageLoaded(locator: ReturnType<Page["locator"]>) {
  await expect(locator).toBeVisible();
  await expect
    .poll(() =>
      locator.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
}
