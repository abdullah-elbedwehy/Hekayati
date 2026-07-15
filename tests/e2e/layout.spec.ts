import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  expectAccessible,
  monitorExternalRequests,
} from "./support/library-fixture.js";
import {
  reservePort,
  startApp,
  stopApp,
  type RunningApp,
} from "./support/running-app.js";

test.setTimeout(150_000);

test("Arabic layout proof and exact approval work at narrow and wide widths", async ({
  page,
}) => {
  const root = join(tmpdir(), `hekayati-e2e-layout-${Date.now()}`);
  const port = await reservePort();
  const external = monitorExternalRequests(page);
  let running: RunningApp | null = null;
  try {
    running = await startApp(root, port, {
      entryScript: "tests/fixtures/start-layout-app.ts",
      environment: { HEKAYATI_LAYOUT_MODE: "seed" },
    });
    const state = await layoutState(root);
    await waitForReady(running.origin, state);
    await openPreview(page, running.origin);
    await verifyReadyProof(page);
    await verifyResponsiveAccessibleUi(page);
    await approveExactPreview(page);
    expect(external).toEqual([]);
  } finally {
    if (running) await stopApp(running, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

interface LayoutFixtureState {
  projectId: string;
  scope: { familyId: string };
}

async function layoutState(root: string): Promise<LayoutFixtureState> {
  return JSON.parse(
    await readFile(join(root, "layout-restart-fixture.json"), "utf8"),
  ) as LayoutFixtureState;
}

async function waitForReady(
  origin: string,
  state: LayoutFixtureState,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await fetch(
          `${origin}/api/layout/projects/${state.projectId}?familyId=${state.scope.familyId}`,
        );
        const snapshot = (await response.json()) as {
          workflow?: { state: string };
        };
        return snapshot.workflow?.state;
      },
      { timeout: 90_000 },
    )
    .toBe("ready");
}

async function openPreview(page: Page, origin: string): Promise<void> {
  await page.goto(origin);
  const acknowledge = page.getByRole("button", { name: "فهمت" });
  await acknowledge
    .waitFor({ state: "visible", timeout: 2_000 })
    .catch(() => {});
  if (await acknowledge.isVisible()) await acknowledge.click();
  await page
    .getByRole("button", { name: "المعاينة والاعتماد", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "المعاينة والاعتماد" }),
  ).toBeVisible();
  await expect(page.getByLabel("العائلة")).toHaveValue(/.+/u);
  await expect(page.getByLabel("المشروع")).toHaveValue(/.+/u);
  await expect(
    page.getByRole("heading", { name: "صفحات الكتاب" }),
  ).toBeVisible();
}

async function verifyReadyProof(page: Page): Promise<void> {
  await expect(page.getByText("16 صفحة", { exact: true })).toBeVisible();
  await expect(page.locator(".preview-page-card")).toHaveCount(16);
  await expect(page.getByText("✓ صالح للتنزيل")).toBeVisible();
  await expect(page.getByTitle("ملف معاينة الكتاب المائي")).toHaveAttribute(
    "src",
    /\/api\/layout\/previews\/.+\/pdf\?familyId=/u,
  );
  await expect(
    page.getByRole("link", { name: "تنزيل ملف المعاينة" }),
  ).toHaveAttribute("href", /\/api\/layout\/previews\//u);
  await expect(page.getByText("✓ صفر")).toBeVisible();
  await expect(page.getByText("✓ لا توجد تحذيرات تنسيق.")).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("id", "main-content");
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
}

async function verifyResponsiveAccessibleUi(page: Page): Promise<void> {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await expectPreviewViewportFit(page, viewport);
    await expectAccessible(page);
    await captureUiEvidence(page, viewport.width);
  }
  const refresh = page.getByRole("button", { name: "تحديث الحالة" });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  expect(
    await refresh.evaluate((element) =>
      parseFloat(getComputedStyle(element).outlineWidth),
    ),
  ).toBeGreaterThanOrEqual(2);
  expect(
    await page
      .locator("button, select, textarea, a.button")
      .evaluateAll((elements) =>
        elements
          .filter((element) => (element as HTMLElement).offsetParent !== null)
          .every((element) => element.getBoundingClientRect().height >= 44),
      ),
  ).toBe(true);
}

async function captureUiEvidence(page: Page, width: number): Promise<void> {
  const directory = process.env.HEKAYATI_LAYOUT_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await page.screenshot({
    path: join(directory, `008-ui-${width}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

async function expectPreviewViewportFit(
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(
        "button:not(.preview-page-card), input, select, textarea, a.button",
      )
      .evaluateAll((elements) =>
        elements
          .filter((element) => (element as HTMLElement).offsetParent !== null)
          .every((element) => {
            const box = element.getBoundingClientRect();
            return box.left >= -1 && box.right <= window.innerWidth + 1;
          }),
      ),
  ).toBe(true);
  await expect(page.locator(".preview-page-list")).toHaveCSS(
    "overflow-x",
    "auto",
  );
}

async function approveExactPreview(page: Page): Promise<void> {
  await page.getByRole("button", { name: "سجّلت إرسال هذه النسخة" }).click();
  await expect(
    page.getByRole("button", { name: "تسجيل موافقة العميل" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "تسجيل موافقة العميل" }).click();
  await expect(page.getByText(/يوجد تفويض محتوى حالي/u)).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "اعتماد العميل" })
      .getByText("معتمدة", { exact: true }),
  ).toBeVisible();
}
