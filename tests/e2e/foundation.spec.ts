import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test("Arabic RTL foundation persists settings with no external telemetry", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const fonts = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 16px "Source Sans 3"', "ABC 123"),
      document.fonts.load('400 16px "IBM Plex Sans Arabic"', "حكايتي"),
      document.fonts.load('700 32px "Lemonada"', "حكايتي"),
    ]);
    return {
      body: getComputedStyle(document.body).fontFamily,
      source: document.fonts.check('400 16px "Source Sans 3"'),
      arabic: document.fonts.check('400 16px "IBM Plex Sans Arabic"'),
      display: document.fonts.check('700 32px "Lemonada"'),
    };
  });
  expect(fonts.body).toContain('"Source Sans 3"');
  expect(fonts).toMatchObject({ source: true, arabic: true, display: true });
  await expect(
    page.getByRole("heading", { name: "لا يوجد نسخ احتياطي تلقائي" }),
  ).toBeVisible();
  await expect(
    page.getByText("التصدير ينقل نسخة مشروع، لكنه ليس نظام نسخ احتياطي."),
  ).toBeVisible();
  let failAcknowledgement = true;
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT" && failAcknowledgement) {
      await route.fulfill({ status: 500, body: '{"code":"TEST_FAILURE"}' });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "فهمت" }).click();
  await expect(
    page.getByText("تعذّر حفظ التأكيد. راجع حالة النظام ثم حاول مرة أخرى."),
  ).toBeVisible();
  failAcknowledgement = false;
  await page.getByRole("button", { name: "فهمت" }).click();
  await expect(
    page.getByRole("heading", { name: "لا يوجد نسخ احتياطي تلقائي" }),
  ).toBeHidden();

  await expect(
    page.getByRole("heading", { name: "أساس هادئ لكل حكاية" }),
  ).toBeVisible();
  await expect(page.getByText("حالتهم ظاهرة في التشخيص")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expectAccessible(page);

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();

  await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
  await expect(page.getByText("دورة اتصال المزوّدين")).toBeVisible();
  await expect(page.getByText("ملفات الطباعة")).toBeVisible();
  await expectAccessible(page);
  const watermark = page.getByLabel("نص العلامة المائية");
  await watermark.fill("معاينة حكايتي المحلية");
  await page.getByRole("button", { name: "حفظ الإعدادات" }).click();
  await expect(page.getByText("حُفظت الإعدادات على هذا الجهاز.")).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "لا يوجد نسخ احتياطي تلقائي" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
  await expect(page.getByLabel("نص العلامة المائية")).toHaveValue(
    "معاينة حكايتي المحلية",
  );

  await page.getByRole("button", { name: "حالة النظام" }).click();
  await expect(
    page.getByRole("heading", { name: "حالة النظام" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "اتصال المزوّدين" })
      .getByText("لم يُفحص", { exact: true })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "تنفيذ المهام" })
      .getByText("يعمل", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("مقيّد بالجهاز", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "فحص الملفات الآن" }).click();
  await expect(
    page.getByText("الفحص يبلّغ فقط، ولا يعيد التوليد أو يغيّر الملفات."),
  ).toBeVisible();
  await expectAccessible(page);
  expect(await page.locator("body").innerText()).not.toMatch(/[٠-٩]/);

  if (process.env.HEKAYATI_UPDATE_EVIDENCE === "1") {
    const evidence = resolve("specs/002-local-foundation/evidence");
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: resolve(evidence, "002-shell-1440x900.png"),
    });
  }
  expect(externalRequests).toEqual([]);
});

test("all foundation views fit narrow and wide screens with visible focus and reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  for (const size of [
    { width: 390, height: 844 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    for (const view of ["البداية", "الإعدادات", "حالة النظام"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      expect(await hasNoHorizontalOverflow(page)).toBe(true);
      expect(await interactiveControlsFit(page)).toBe(true);
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "البداية", exact: true }).click();
  const focusTarget = page.getByRole("button", { name: "افتح حالة النظام" });
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    if (
      await focusTarget.evaluate(
        (element) => element === document.activeElement,
      )
    )
      break;
  }
  await expect(focusTarget).toBeFocused();
  const focusStyle = await focusTarget.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineWidth: parseFloat(style.outlineWidth),
      shadow: style.boxShadow,
    };
  });
  expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(focusStyle.shadow).not.toBe("none");
  expect(await maxTransitionMilliseconds(page, ".nav-item")).toBeLessThan(1);
});

test("health UI identifies every affected asset and reason", async ({
  page,
}) => {
  await page.goto("/");
  const health = await page.evaluate(async () =>
    fetch("/api/health").then((response) => response.json()),
  );
  const assetId = "01K0TESTASSET0000000000000";
  await page.route("**/api/health", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...health,
        disk: { status: "warning", freeGb: 5, thresholdGb: 10 },
        integrity: {
          checked: 1,
          healthy: 0,
          scannedAt: new Date().toISOString(),
          issues: [{ assetId, reason: "checksum_mismatch" }],
        },
      }),
    }),
  );
  await page.getByRole("button", { name: "حالة النظام", exact: true }).click();
  await page.getByRole("button", { name: "تحديث الحالة" }).click();
  await expect(page.getByTitle(assetId)).toBeVisible();
  await expect(page.getByText("بصمة الملف لا تطابق السجل")).toBeVisible();
  await expect(page.getByText("5 جيجابايت، أقل من حد التحذير")).toBeVisible();
});

async function expectAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}

function hasNoHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
}

function interactiveControlsFit(page: Page): Promise<boolean> {
  return page.locator("button, input, select").evaluateAll((elements) =>
    elements
      .filter((element) => (element as HTMLElement).offsetParent !== null)
      .every((element) => {
        const box = element.getBoundingClientRect();
        return box.left >= -1 && box.right <= window.innerWidth + 1;
      }),
  );
}

function maxTransitionMilliseconds(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const values = getComputedStyle(element).transitionDuration.split(",");
      return Math.max(
        ...values.map((value) => {
          const trimmed = value.trim();
          return trimmed.endsWith("ms")
            ? parseFloat(trimmed)
            : parseFloat(trimmed) * 1000;
        }),
      );
    });
}
