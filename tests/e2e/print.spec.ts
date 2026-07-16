import { access, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { PrintProjectProjection } from "../../src/ui/print-types.js";

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

test.setTimeout(180_000);

const printViewports = [
  { width: 390, height: 844 },
  { width: 1_440, height: 900 },
  { width: 1_920, height: 1_080 },
];

test("Arabic print production survives SIGKILL and exposes only exact deliverables", async ({
  page,
}) => {
  const root = join(tmpdir(), `hekayati-e2e-print-${Date.now()}`);
  const port = await reservePort();
  const external = monitorExternalRequests(page);
  let running: RunningApp | null = null;
  try {
    running = await startPrintApp(root, port, "seed", {
      faultStage: "interior_render",
    });
    const state = await printFixtureState(root);
    await waitForLayout(running.origin, state);
    await approvePreview(page, running.origin);
    await configurePrintProfile(page);
    await page.getByRole("button", { name: "إنتاج الداخل والغلاف" }).click();
    await waitForFaultMarker(root, "interior_render");

    await stopApp(running, "SIGKILL");
    running = await startPrintApp(root, port, "resume");
    const projection = await waitForDeliverable(running.origin, state);
    expect(projection.report).toMatchObject({ passed: true, findings: [] });

    await openPrintWorkspace(page, running.origin);
    await expect(
      page.getByRole("heading", { name: "الداخل والغلاف اجتازا كل البوابات" }),
    ).toBeVisible();
    await verifyPrintUi(page);
    await verifyDownloads(page, running.origin, state, projection.run!.id);
    expect(external).toEqual([]);
  } finally {
    if (running) await stopApp(running, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

test("CMYK candidate proof is visibly non-deliverable and only its exact UI action releases files", async ({
  page,
}) => {
  const root = join(tmpdir(), `hekayati-e2e-print-cmyk-${Date.now()}`);
  const port = await reservePort();
  const external = monitorExternalRequests(page);
  let running: RunningApp | null = null;
  try {
    running = await startPrintApp(root, port, "seed", { autoStart: "cmyk" });
    const state = await printFixtureState(root);
    const candidate = await waitForPrintState(
      running.origin,
      state,
      "converted_proof_pending",
    );
    const runId = candidate.run!.id;
    for (const kind of ["interior", "cover"] as const) {
      const proof = await page.request.get(
        `${running.origin}/api/print/runs/${runId}/proof/${kind}?familyId=${state.scope.familyId}`,
      );
      expect(proof.status()).toBe(200);
      expect(proof.headers()["x-hekayati-deliverable"]).toBe("false");
      const final = await page.request.get(
        `${running.origin}/api/print/runs/${runId}/download/${kind}?familyId=${state.scope.familyId}`,
      );
      expect(final.status()).not.toBe(200);
    }

    await openPrintWorkspace(page, running.origin, "بانتظار بروفة اللون");
    await expect(
      page.getByRole("heading", {
        name: "بروفة ألوان CMYK — ليست ملفًا قابلًا للتسليم",
      }),
    ).toBeVisible();
    await expect(page.locator(".print-proof img")).toHaveCount(2);
    await page.getByRole("button", { name: "اعتماد البروفة الدقيقة" }).click();
    await expect(
      page.getByRole("heading", { name: "الداخل والغلاف اجتازا كل البوابات" }),
    ).toBeVisible({ timeout: 30_000 });
    await waitForPrintState(running.origin, state, "deliverable");
    await verifyDownloads(page, running.origin, state, runId);
    expect(external).toEqual([]);
  } finally {
    if (running) await stopApp(running, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

test("blocking findings and mutation errors stay readable and programmatic at every supported width", async ({
  page,
}) => {
  const root = join(tmpdir(), `hekayati-e2e-print-errors-${Date.now()}`);
  const port = await reservePort();
  const external = monitorExternalRequests(page);
  let running: RunningApp | null = null;
  try {
    running = await startPrintApp(root, port, "seed", {
      autoStart: "rgb",
      fastFixture: true,
    });
    const state = await printFixtureState(root);
    const projection = await waitForDeliverable(running.origin, state);
    const blockingReason =
      "توقّف التسليم لأن منطقة الأمان في صفحة القصة المعتمدة لا تطابق ملف الطابعة الحالي ويجب مراجعة القياس قبل إعادة التشغيل";
    const expected =
      "يجب أن يبقى النص العربي كاملًا داخل منطقة الأمان المحددة مع هامش صالح للطباعة على جميع الحواف";
    const actual =
      "امتد السطر العربي خارج الحد الآمن في الصفحة الاصطناعية الطويلة بعد تطبيق هندسة ملف الطابعة";
    const blocked = blockedProjection(
      projection,
      blockingReason,
      expected,
      actual,
    );
    await mockBlockedProjection(page, running.origin, state, blocked);

    await openPrintWorkspace(page, running.origin, "متوقف");
    await expect(
      page.getByRole("status").filter({ hasText: "الإنتاج متوقف" }),
    ).toContainText(blockingReason);
    await expect(
      page.getByRole("heading", { name: "! توجد عيوب مانعة" }),
    ).toBeVisible();
    const finding = page
      .getByRole("listitem")
      .filter({ hasText: "SAFE_MARGIN_VIOLATION" });
    await expect(finding).toContainText(expected);
    await expect(finding).toContainText(actual);
    await verifyResponsiveErrorUi(page);

    await page.getByRole("button", { name: "ملف جديد" }).click();
    await page.getByLabel("اسم الملف").fill("ملف يختبر خطأ الحفظ المرئي");
    await page.getByLabel("عرض الكعب (مم)").fill("8");
    await page.getByRole("button", { name: "إنشاء ملف الطابعة" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "تعذّر تنفيذ إجراء الطباعة. راجع الاعتماد وبيانات الطابعة ثم حاول مرة أخرى.",
    );
    expect(external).toEqual([]);
  } finally {
    if (running) await stopApp(running, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

interface PrintFixtureState {
  projectId: string;
  scope: { familyId: string };
}

function startPrintApp(
  root: string,
  port: number,
  mode: "seed" | "resume",
  options: {
    autoStart?: "rgb" | "cmyk";
    faultStage?: "interior_render";
    fastFixture?: boolean;
  } = {},
) {
  return startApp(root, port, {
    entryScript: "tests/fixtures/start-print-app.ts",
    environment: {
      HEKAYATI_PRINT_MODE: mode,
      ...(options.autoStart
        ? { HEKAYATI_PRINT_AUTOSTART: options.autoStart }
        : {}),
      ...(options.faultStage
        ? { HEKAYATI_PRINT_FAULT_STAGE: options.faultStage }
        : {}),
      ...(options.fastFixture ? { HEKAYATI_PRINT_FAST_FIXTURE: "1" } : {}),
    },
  });
}

async function printFixtureState(root: string): Promise<PrintFixtureState> {
  return JSON.parse(
    await readFile(join(root, "print-e2e-fixture.json"), "utf8"),
  ) as PrintFixtureState;
}

async function waitForLayout(
  origin: string,
  state: PrintFixtureState,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const response = await fetch(
            `${origin}/api/layout/projects/${state.projectId}?familyId=${state.scope.familyId}`,
          );
          const body = (await response.json()) as {
            workflow?: { state: string };
          };
          return body.workflow?.state;
        },
        { timeout: 90_000 },
      )
      .toBe("ready");
  } catch (error) {
    throw new Error(
      `PRINT_LAYOUT_TIMEOUT ${await jobDiagnostics(origin, "layout")}`,
      { cause: error },
    );
  }
}

async function approvePreview(page: Page, origin: string): Promise<void> {
  await page.goto(origin);
  await dismissOnboarding(page);
  await page
    .getByRole("button", { name: "المعاينة والاعتماد", exact: true })
    .click();
  await expect(page.getByText("✓ صالح للتنزيل")).toBeVisible();
  await page.getByRole("button", { name: "سجّلت إرسال هذه النسخة" }).click();
  await page.getByRole("button", { name: "تسجيل موافقة العميل" }).click();
  await expect(page.getByText(/يوجد تفويض محتوى حالي/u)).toBeVisible();
}

async function dismissOnboarding(page: Page): Promise<void> {
  const acknowledge = page.getByRole("button", { name: "فهمت" });
  await acknowledge
    .waitFor({ state: "visible", timeout: 2_000 })
    .catch(() => {});
  if (await acknowledge.isVisible()) await acknowledge.click();
}

async function configurePrintProfile(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "الإنتاج الطباعي", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "الإنتاج الطباعي" }),
  ).toBeVisible();
  const profileName =
    "طابعة اصطناعية آمنة للاختبار الطويل RGB — نسخة مطبعة القاهرة 2026";
  await page.getByLabel("اسم الملف").fill(profileName);
  await page.getByLabel("عرض الكعب (مم)").fill("8");
  await page.getByRole("button", { name: "إنشاء ملف الطابعة" }).click();
  await expect(
    page.getByLabel("تحرير ملف محفوظ").locator("option"),
  ).toHaveCount(2);
  const profileSelect = page.getByLabel("تحرير ملف محفوظ");
  const profileId = await profileSelect
    .locator("option")
    .filter({ hasText: profileName })
    .getAttribute("value");
  if (!profileId) throw new Error("PRINT_PROFILE_OPTION_MISSING");
  await profileSelect.selectOption(profileId);
  await page.getByRole("button", { name: "ربطه بالمشروع المختار" }).click();
  await expect(
    page
      .getByLabel("جاهزية الطباعة")
      .getByText("✓ مكتمل محليًا", { exact: true }),
  ).toBeVisible();
}

async function waitForFaultMarker(root: string, stage: string): Promise<void> {
  const marker = join(root, `print-fault-${stage}.ready`);
  await expect
    .poll(
      async () => {
        try {
          await access(marker);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000, intervals: [5, 10, 20, 50] },
    )
    .toBe(true);
}

async function waitForDeliverable(
  origin: string,
  state: PrintFixtureState,
): Promise<PrintProjectProjection> {
  return waitForPrintState(origin, state, "deliverable");
}

async function waitForPrintState(
  origin: string,
  state: PrintFixtureState,
  expected: "converted_proof_pending" | "deliverable",
): Promise<PrintProjectProjection> {
  let latest: PrintProjectProjection | null = null;
  try {
    await expect
      .poll(
        async () => {
          const response = await fetch(
            `${origin}/api/print/projects/${state.projectId}?familyId=${state.scope.familyId}`,
          );
          latest = (await response.json()) as PrintProjectProjection;
          if (
            ["blocked", "rejected", "stale"].includes(latest.run?.state ?? "")
          )
            return `failed:${latest.run?.state}`;
          return latest.run?.state;
        },
        { timeout: 90_000 },
      )
      .toBe(expected);
  } catch (error) {
    throw new Error(
      `PRINT_STATE_TIMEOUT expected=${expected} actual=${projectionState(latest)} ${await jobDiagnostics(origin, "print_")}`,
      { cause: error },
    );
  }
  if (!latest) throw new Error("PRINT_PROJECTION_MISSING");
  return latest;
}

function projectionState(projection: PrintProjectProjection | null): string {
  return projection?.run?.state ?? "none";
}

async function jobDiagnostics(origin: string, prefix: string): Promise<string> {
  try {
    const response = await fetch(`${origin}/api/jobs`);
    const body = (await response.json()) as {
      jobs?: Array<{
        id?: string;
        jobType?: string;
        state?: string;
        attempts?: number;
        stateReason?: string | null;
        failure?: { category?: string; reasonCode?: string } | null;
      }>;
    };
    return JSON.stringify(
      (body.jobs ?? [])
        .filter((job) =>
          prefix === "layout"
            ? job.jobType?.includes("layout") ||
              job.jobType?.includes("preview")
            : job.jobType?.startsWith(prefix),
        )
        .map((job) => ({
          id: job.id,
          type: job.jobType,
          state: job.state,
          attempts: job.attempts,
          reason: job.stateReason,
          failure: job.failure
            ? {
                category: job.failure.category,
                code: job.failure.reasonCode,
              }
            : null,
        })),
    ).slice(0, 2_000);
  } catch {
    return "jobs_unavailable";
  }
}

async function openPrintWorkspace(
  page: Page,
  origin: string,
  expectedState = "جاهز للتسليم",
): Promise<void> {
  await page.goto(origin);
  await dismissOnboarding(page);
  await page
    .getByRole("button", { name: "الإنتاج الطباعي", exact: true })
    .click();
  await expect(
    page.locator(".print-state").getByText(expectedState, { exact: true }),
  ).toBeVisible();
}

async function verifyPrintUi(page: Page): Promise<void> {
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  await expect(page.getByText("✓ اجتاز الفحص")).toBeVisible();
  await expect(page.getByText("توافق التكوين", { exact: true })).toBeVisible();
  await expect(
    page.getByText("✓ مطابق للنسخة المعتمدة", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("نسخة اعتماد العميل", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("نسخة المعاينة", { exact: true })).toBeVisible();
  await expect(
    page.getByText("نسخة ملف الطابعة", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/الجاهزية هنا محلية/u)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "تنزيل ملف الداخل" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "تنزيل فردة الغلاف" }),
  ).toBeVisible();
  expect(await page.locator(".print-view").innerText()).not.toMatch(/[٠-٩]/u);
  for (const viewport of printViewports) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const undersizedControls = await page
      .locator(
        "button, input:not(.visually-hidden), select, textarea, a.button, label.button",
      )
      .evaluateAll((elements) =>
        elements
          .filter((element) => (element as HTMLElement).offsetParent !== null)
          .map((element) => {
            const control = element as HTMLInputElement;
            const target = control.matches(
              'input[type="checkbox"], input[type="radio"]',
            )
              ? (control.closest("label") ?? control)
              : control;
            return {
              label:
                control.getAttribute("aria-label") ??
                target.textContent?.trim() ??
                control.getAttribute("name") ??
                control.tagName,
              tag: control.tagName,
              height: target.getBoundingClientRect().height,
            };
          })
          .filter(({ height }) => height < 44),
      );
    expect(undersizedControls).toEqual([]);
    await expectAccessible(page);
    await captureEvidence(page, viewport.width);
  }
  const refresh = page.getByRole("button", { name: "تحديث الحالة" });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  expect(
    await refresh.evaluate((element) =>
      parseFloat(getComputedStyle(element).outlineWidth),
    ),
  ).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("العائلة")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("المشروع")).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  const movingElements = await page
    .locator(".print-view *")
    .evaluateAll((elements) =>
      elements
        .filter((element) => (element as HTMLElement).offsetParent !== null)
        .flatMap((element) => {
          const style = getComputedStyle(element);
          const durationInMilliseconds = (value: string): number => {
            const duration = Number.parseFloat(value);
            if (!Number.isFinite(duration)) return Number.POSITIVE_INFINITY;
            if (value.endsWith("ms")) return duration;
            if (value.endsWith("s")) return duration * 1_000;
            return Number.POSITIVE_INFINITY;
          };
          const durations =
            `${style.animationDuration},${style.transitionDuration}`
              .split(",")
              .map((value) => value.trim());
          return durations.some(
            (value) => durationInMilliseconds(value) > 0.011,
          )
            ? [element.tagName]
            : [];
        }),
    );
  expect(movingElements).toEqual([]);
}

function blockedProjection(
  projection: PrintProjectProjection,
  blockingReason: string,
  expected: string,
  actual: string,
): PrintProjectProjection {
  if (!projection.run || !projection.report)
    throw new Error("PRINT_DELIVERABLE_PROJECTION_INCOMPLETE");
  return {
    ...structuredClone(projection),
    run: {
      ...projection.run,
      state: "blocked",
      blockingReasons: [blockingReason],
    },
    report: {
      ...projection.report,
      passed: false,
      findings: [
        {
          code: "SAFE_MARGIN_VIOLATION",
          artifact: "interior",
          page: 12,
          expected,
          actual,
        },
      ],
    },
  };
}

async function mockBlockedProjection(
  page: Page,
  origin: string,
  state: PrintFixtureState,
  projection: PrintProjectProjection,
): Promise<void> {
  await page.route(
    `${origin}/api/print/projects/${state.projectId}*`,
    async (route) => await route.fulfill({ status: 200, json: projection }),
  );
  await page.route(`${origin}/api/print/profiles`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      json: { code: "PRINT_SYNTHETIC_FAILURE" },
    });
  });
}

async function verifyResponsiveErrorUi(page: Page): Promise<void> {
  for (const viewport of printViewports) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expectAccessible(page);
  }
}

async function verifyDownloads(
  page: Page,
  origin: string,
  state: PrintFixtureState,
  runId: string,
): Promise<void> {
  for (const kind of ["interior", "cover"] as const) {
    const response = await page.request.get(
      `${origin}/api/print/runs/${runId}/download/${kind}?familyId=${state.scope.familyId}`,
    );
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["content-type"]).toContain("application/pdf");
    expect((await response.body()).length).toBeGreaterThan(1_000);
  }
}

async function captureEvidence(page: Page, width: number): Promise<void> {
  const directory = process.env.HEKAYATI_PRINT_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await page.screenshot({
    path: join(directory, `009-ui-${width}.png`),
    fullPage: true,
    animations: "disabled",
  });
}
