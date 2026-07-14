import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { resolveDataPaths } from "../../src/config/paths.js";
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

const projectA = "01J00000000000000000000001";
const projectB = "01J00000000000000000000002";

test.setTimeout(150_000);

test("Arabic queue preserves scoped quota decisions and survives SIGKILL", async ({
  page,
  request,
}) => {
  const root = await mkdtemp(join(tmpdir(), "hekayati-e2e-jobs-"));
  const dataDir = join(root, "data");
  const external = monitorExternalRequests(page);
  let running: RunningApp | null = null;
  try {
    running = await startJobApp(dataDir, await reservePort());
    await openQueue(page, running.origin);
    await verifyInitialQueue(page, request, running.origin);
    const settingsBefore = await readJson(
      request,
      `${running.origin}/api/settings`,
    );
    await chooseQuotaDecisions(page);
    const after = await readQueue(request, running.origin);
    verifyScopedContinuation(after);
    expect(await readJson(request, `${running.origin}/api/settings`)).toEqual(
      settingsBefore,
    );
    const port = Number(new URL(running.origin).port);
    await stopApp(running, "SIGKILL");
    running = null;
    verifyQuotaAudits(dataDir);
    running = await startJobApp(dataDir, port);
    await openQueue(page, running.origin);
    verifyScopedContinuation(await readQueue(request, running.origin), true);
    await verifyQueuePresentation(page);
    expect(await readOptional(`${dataDir}-provider-calls.log`)).toBe("");
    expect(external).toEqual([]);
  } finally {
    if (running) await stopApp(running, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

function startJobApp(dataDir: string, port: number) {
  const security = resolve("tests/fixtures/fake-security.ts");
  return chmod(security, 0o755).then(() =>
    startApp(dataDir, port, {
      entryScript: "tests/fixtures/start-job-app.ts",
      environment: {
        HEKAYATI_FAKE_SECURITY_BINARY: security,
        HEKAYATI_FAKE_KEYCHAIN_FILE: `${dataDir}-keychain/operator.secret`,
        HEKAYATI_PROVIDER_CALL_LOG: `${dataDir}-provider-calls.log`,
      },
    }),
  );
}

async function openQueue(page: Page, origin: string): Promise<void> {
  await page.goto(origin);
  const acknowledgement = page.getByRole("button", { name: "فهمت" });
  if (await acknowledgement.isVisible()) await acknowledgement.click();
  await page.getByRole("button", { name: "قائمة المهام", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "قائمة المهام" }),
  ).toBeVisible();
}

async function verifyInitialQueue(
  page: Page,
  request: APIRequestContext,
  origin: string,
): Promise<void> {
  const queue = await readQueue(request, origin);
  expect(queue.jobs.filter((job) => job.state === "succeeded")).toHaveLength(
    14,
  );
  expect(
    queue.jobs.filter(
      (job) => job.state === "paused" && job.stateReason === "quota",
    ),
  ).toHaveLength(6);
  expect(queue.quotaIncidents[0]?.scopes).toHaveLength(2);
  expect(queue.quotaIncidents[0]?.alternateTargets).toMatchObject([
    { providerId: "gemini", operation: "image" },
  ]);
  await verifyQueuePresentation(page);
}

async function chooseQuotaDecisions(page: Page): Promise<void> {
  await page.getByRole("button", { name: "اختر قرار كل نطاق" }).click();
  await page.getByLabel("نطاق القرار").selectOption(projectB);
  await expectAccessible(page);
  await page.getByRole("button", { name: "انتظار عودة المزوّد" }).click();
  await expect(
    page.getByText("سُجّل قرار الانتظار لهذا النطاق."),
  ).toBeVisible();

  await page.getByRole("button", { name: "اختر قرار كل نطاق" }).click();
  await page.getByLabel("نطاق القرار").selectOption(projectA);
  await page
    .getByRole("button", { name: /متابعة المهام المتبقية عبر Gemini/ })
    .click();
  await expect(
    page.getByText("أُنشئت مهام بديلة مرتبطة لهذا النطاق."),
  ).toBeVisible();
}

interface QueueSnapshot {
  jobs: Array<{
    id: string;
    projectId: string | null;
    state: string;
    stateReason: string | null;
    target: { providerId: string; operation: string } | null;
    provenance: { provider: string } | null;
  }>;
  quotaIncidents: Array<{
    scopes: unknown[];
    alternateTargets: unknown[];
  }>;
}

function verifyScopedContinuation(
  queue: QueueSnapshot,
  afterRestart = false,
): void {
  const projectAJobs = queue.jobs.filter((job) => job.projectId === projectA);
  const projectBJobs = queue.jobs.filter((job) => job.projectId === projectB);
  expect(
    projectAJobs.filter(
      (job) => job.state === "succeeded" && job.provenance?.provider === "mock",
    ),
  ).toHaveLength(14);
  const successors = projectAJobs.filter(
    (job) =>
      job.target?.providerId === "gemini" &&
      (job.state === "queued" || (afterRestart && job.state === "succeeded")),
  );
  expect(successors).toHaveLength(4);
  expect(
    successors.every(
      (job) =>
        job.state !== "succeeded" || job.provenance?.provider === "gemini",
    ),
  ).toBe(true);
  expect(
    projectBJobs.filter(
      (job) => job.state === "paused" && job.stateReason === "quota",
    ),
  ).toHaveLength(2);
}

async function verifyQueuePresentation(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const size of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await expectViewportFit(page, size);
    await expectVisibleTargets(page);
  }
  await expectAccessible(page);
  expect(await page.locator("body").innerText()).not.toMatch(/[٠-٩]/);
  await verifyKeyboardFocus(page);
  if (process.env.HEKAYATI_UPDATE_EVIDENCE === "1") {
    const evidence = resolve("specs/006-durable-job-orchestration/evidence");
    await mkdir(evidence, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: join(evidence, "006-queue-1440x900.png") });
  }
}

async function expectVisibleTargets(page: Page): Promise<void> {
  expect(
    await page.locator("button, select").evaluateAll((elements) =>
      elements
        .filter((element) => (element as HTMLElement).offsetParent !== null)
        .every((element) => {
          const box = element.getBoundingClientRect();
          return box.width >= 44 && box.height >= 44;
        }),
    ),
  ).toBe(true);
}

async function verifyKeyboardFocus(page: Page): Promise<void> {
  const target = page.getByRole("button", { name: "تحديث القائمة" });
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  for (let step = 0; step < 20; step += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement))
      break;
  }
  await expect(target).toBeFocused();
}

async function readQueue(
  request: APIRequestContext,
  origin: string,
): Promise<QueueSnapshot> {
  return readJson(request, `${origin}/api/jobs`) as Promise<QueueSnapshot>;
}

async function readJson(request: APIRequestContext, url: string) {
  const response = await request.get(url);
  expect(response.status()).toBe(200);
  return response.json() as Promise<unknown>;
}

function verifyQuotaAudits(dataDir: string): void {
  const database = new Database(resolveDataPaths(dataDir).database, {
    readonly: true,
  });
  try {
    const rows = database
      .prepare(
        "SELECT doc FROM documents WHERE collection = 'job_audit_events' ORDER BY created_at, id",
      )
      .all() as Array<{ doc: string }>;
    const audits = rows.map(
      (row) => JSON.parse(row.doc) as { decision: string },
    );
    expect(audits.map((audit) => audit.decision)).toEqual(["wait", "continue"]);
  } finally {
    database.close();
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
