import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

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

test("provider settings stay explicit, private, accessible, and restart-safe", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "hekayati-e2e-providers-"));
  const paths = fixturePaths(root);
  const external = monitorExternalRequests(page);
  const apiBodies = captureApiBodies(page);
  const secrets = [syntheticCredential(), syntheticCredential()];
  let running: RunningApp | null = null;
  try {
    await chmod(paths.security, 0o755);
    running = await startProviderApp(paths, await reservePort());
    await openSettings(page, running.origin);
    expect(await readOptional(paths.callLog)).toBe("");
    await exerciseProviderChoices(page);
    await exerciseCredentialAndConnections(page, secrets);
    await exercisePromptPolicy(page);
    await exerciseProviderHealth(page);
    const screenshot = await verifyProviderUi(page, paths);
    const callsBeforeRestart = await readOptional(paths.callLog);
    await stopApp(running, "SIGKILL");
    running = await startProviderApp(
      paths,
      Number(new URL(running.origin).port),
    );
    await openSettings(page, running.origin);
    await verifyRestartedState(page, paths.callLog, callsBeforeRestart);
    await deleteCredential(page);
    await assertSecretIsolation(paths.data, screenshot, apiBodies, secrets);
    expect(external).toEqual([]);
  } finally {
    if (running) await stopApp(running, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

function fixturePaths(root: string) {
  return {
    root,
    data: join(root, "data"),
    keychain: join(root, "keychain", "operator.secret"),
    callLog: join(root, "provider-calls.log"),
    screenshot: join(root, "provider-settings.png"),
    security: resolve("tests/fixtures/fake-security.ts"),
  };
}

function startProviderApp(
  paths: ReturnType<typeof fixturePaths>,
  port: number,
) {
  return startApp(paths.data, port, {
    entryScript: "tests/fixtures/start-provider-app.ts",
    environment: {
      HEKAYATI_FAKE_SECURITY_BINARY: paths.security,
      HEKAYATI_FAKE_KEYCHAIN_FILE: paths.keychain,
      HEKAYATI_PROVIDER_CALL_LOG: paths.callLog,
    },
  });
}

async function openSettings(page: Page, origin: string): Promise<void> {
  await page.goto(origin);
  await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
  const acknowledgement = page.getByRole("button", { name: "فهمت" });
  if (await acknowledgement.isVisible()) await acknowledgement.click();
  await expect(
    page.getByRole("heading", { name: "المزوّدون والنماذج" }),
  ).toBeVisible();
}

async function exerciseProviderChoices(page: Page): Promise<void> {
  const text = page.getByLabel("مزوّد النص");
  const image = page.getByLabel("مزوّد الصور");
  for (const textProvider of ["mock", "codex", "gemini"]) {
    for (const imageProvider of ["mock", "codex", "gemini"]) {
      await text.selectOption(textProvider);
      await image.selectOption(imageProvider);
    }
  }
  await text.selectOption("codex");
  await image.selectOption("gemini");
  await page.getByLabel("مستوى صور Gemini").selectOption("economy");
  await expect(page.getByText(/الاقتصادي قد يقلّل/)).toBeVisible();
  await page.getByLabel("معرّف نموذج نص Codex").fill("gpt-e2e-exact");
  await page.getByLabel("معرّف نموذج نص Gemini").fill("gemini-e2e-text");
  await page
    .getByLabel("معرّف نموذج الصور الاقتصادي")
    .fill("gemini-e2e-image-economy");
  await page.getByRole("button", { name: "حفظ الإعدادات" }).click();
  await expect(page.getByText("حُفظت الإعدادات على هذا الجهاز.")).toBeVisible();
}

async function exerciseCredentialAndConnections(
  page: Page,
  secrets: string[],
): Promise<void> {
  const gemini = providerCard(page, "Gemini");
  await gemini.getByRole("button", { name: "اختبار الاتصال" }).click();
  await expect(gemini.getByText("× غير متاح").first()).toBeVisible();
  const credential = page.getByRole("textbox", { name: "مفتاح Gemini API" });
  await credential.fill(secrets[0]);
  await page.getByRole("button", { name: "حفظ المفتاح" }).click();
  await expect(page.getByText("حُفظ المفتاح في Keychain.")).toBeVisible();
  await expect(page.getByLabel("قيمة مخفية")).toHaveText("••••••••");
  await credential.fill(secrets[1]);
  await page.getByRole("button", { name: "استبدال المفتاح" }).click();
  await expect(credential).toHaveValue("");
  await testAvailableProvider(providerCard(page, "المزوّد التجريبي"));
  await testAvailableProvider(providerCard(page, "Codex"));
  await testAvailableProvider(gemini);
  await expect(gemini.getByText("gemini-e2e-text")).toBeVisible();
  await expect(gemini.getByText("gemini-e2e-image-economy")).toBeVisible();
  await expect(providerCard(page, "Codex").getByRole("note")).toContainText(
    "G1-I: إنشاء الصور",
  );
}

function providerCard(page: Page, heading: string) {
  return page.locator("article.provider-card").filter({
    has: page.getByRole("heading", { name: heading, exact: true }),
  });
}

async function testAvailableProvider(
  card: ReturnType<typeof providerCard>,
): Promise<void> {
  await card.getByRole("button", { name: "اختبار الاتصال" }).click();
  await expect(card.getByText("✓ متاح").first()).toBeVisible();
}

async function exercisePromptPolicy(page: Page): Promise<void> {
  await page
    .getByLabel("وصف بصري للاختبار")
    .fill("مشهد مرح بأسلوب Disney داخل حديقة");
  await page.getByRole("button", { name: "فحص الوصف" }).click();
  await expect(
    page.getByRole("heading", { name: "استخدم وصفًا بصريًا أصليًا" }),
  ).toBeVisible();
  await page.getByLabel(/أوافق على استخدام البديل الأصلي/).check();
  await page.getByRole("button", { name: "تأكيد البديل الأصلي" }).click();
  await expect(page.getByText(/تأكد البديل الأصلي/)).toBeVisible();
}

async function exerciseProviderHealth(page: Page): Promise<void> {
  await page.getByRole("button", { name: "حالة النظام", exact: true }).click();
  await page.getByRole("button", { name: "تحديث الحالة" }).click();
  await expect(
    page.getByRole("heading", { name: "اتصال المزوّدين" }),
  ).toBeVisible();
  await expect(page.getByText(/النص: Codex · الصور: Gemini/)).toBeVisible();
  await expect(page.getByText("gpt-e2e-exact")).toBeVisible();
  await expect(page.getByText("المصادقة: صالحة").first()).toBeVisible();
  await expect(page.getByText(/حدود الصور: 4 مرجعًا · 4 شخصيات/)).toBeVisible();
  await expect(page.getByText(/نتيجة مؤقتة/).first()).toBeVisible();
  await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
}

async function verifyProviderUi(
  page: Page,
  paths: ReturnType<typeof fixturePaths>,
): Promise<Buffer> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const size of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await expectViewportFit(page, size);
  }
  await expectAccessible(page);
  await expectMinimumTargetSizes(page);
  expect(await page.locator("body").innerText()).not.toMatch(/[٠-٩]/);
  for (const secret of [await readOptional(paths.keychain)]) {
    expect(await page.locator("body").innerText()).not.toContain(secret);
  }
  await page.locator(".provider-card-grid").scrollIntoViewIfNeeded();
  const screenshot = await page.screenshot({ path: paths.screenshot });
  if (process.env.HEKAYATI_UPDATE_EVIDENCE === "1") {
    const evidence = resolve("specs/005-ai-provider-boundary/evidence");
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "005-providers-1920x1080.png"),
    });
  }
  return screenshot;
}

async function expectMinimumTargetSizes(page: Page): Promise<void> {
  const tooSmall = await page
    .locator("button, input:not([type=checkbox]), select, textarea")
    .evaluateAll((elements) =>
      elements
        .filter((element) => (element as HTMLElement).offsetParent !== null)
        .filter((element) => element.getBoundingClientRect().height < 44)
        .map((element) => element.outerHTML.slice(0, 120)),
    );
  expect(tooSmall).toEqual([]);
}

async function verifyRestartedState(
  page: Page,
  callLogPath: string,
  callsBeforeRestart: string,
): Promise<void> {
  await expect(page.getByLabel("مزوّد النص")).toHaveValue("codex");
  await expect(page.getByLabel("مزوّد الصور")).toHaveValue("gemini");
  await expect(page.getByLabel("مستوى صور Gemini")).toHaveValue("economy");
  await expect(page.getByLabel("معرّف نموذج نص Codex")).toHaveValue(
    "gpt-e2e-exact",
  );
  await expect(page.getByText("✓ المفتاح موجود")).toBeVisible();
  expect(await readOptional(callLogPath)).toBe(callsBeforeRestart);
}

async function deleteCredential(page: Page): Promise<void> {
  await page.getByRole("button", { name: "حذف المفتاح" }).click();
  await page.getByRole("button", { name: "تأكيد حذف المفتاح" }).click();
  await expect(page.getByText("○ المفتاح غير موجود")).toBeVisible();
}

function captureApiBodies(page: Page): Array<Promise<string>> {
  const bodies: Array<Promise<string>> = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/")) {
      bodies.push(response.body().then((body) => body.toString("utf8")));
    }
  });
  return bodies;
}

async function assertSecretIsolation(
  dataRoot: string,
  screenshot: Buffer,
  bodyPromises: Array<Promise<string>>,
  secrets: string[],
): Promise<void> {
  const corpus = [
    ...(await readTree(dataRoot)),
    screenshot,
    Buffer.from((await Promise.all(bodyPromises)).join("\n")),
  ];
  for (const secret of secrets) {
    const bytes = Buffer.from(secret);
    expect(corpus.some((item) => item.includes(bytes))).toBe(false);
  }
}

async function readTree(root: string): Promise<Buffer[]> {
  const values: Buffer[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) values.push(...(await readTree(path)));
    else values.push(await readFile(path));
  }
  return values;
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function syntheticCredential(): string {
  return [["AI", "za"].join(""), "fixture", randomUUID()].join("-");
}
