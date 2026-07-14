import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  reservePort,
  startApp,
  stopApp,
  type RunningApp,
} from "./support/running-app.js";

test("process kill and restart preserve UI state while rotating the browser token", async ({
  page,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), "hekayati-e2e-restart-"));
  const port = await reservePort();
  let running: RunningApp | null = null;
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname !== "127.0.0.1")
      externalRequests.push(request.url());
  });

  try {
    running = await startApp(dataDir, port);
    await page.goto(running.origin);
    await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
    await page.getByRole("button", { name: "فهمت" }).click();
    await page.getByLabel("نص العلامة المائية").fill("يبقى بعد قتل العملية");
    await page.getByRole("button", { name: "حفظ الإعدادات" }).click();
    await expect(
      page.getByText("حُفظت الإعدادات على هذا الجهاز."),
    ).toBeVisible();

    await stopApp(running, "SIGKILL");
    running = await startApp(dataDir, port);
    await page.getByLabel("نص العلامة المائية").fill("يجب ألا يُحفظ برمز قديم");
    await page.getByRole("button", { name: "حفظ الإعدادات" }).click();
    await expect(
      page.getByRole("heading", { name: "انتهت جلسة التبويب المحلية" }),
    ).toBeVisible();

    const persisted = await fetch(`${running.origin}/api/settings`).then(
      (response) => response.json() as Promise<{ watermarkText: string }>,
    );
    expect(persisted.watermarkText).toBe("يبقى بعد قتل العملية");

    await page.getByRole("button", { name: "إعادة التحميل" }).click();
    await expect(
      page.getByRole("heading", { name: "أساس هادئ لكل حكاية" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "لا يوجد نسخ احتياطي تلقائي" }),
    ).toBeHidden();
    await page.getByRole("button", { name: "الإعدادات", exact: true }).click();
    await expect(page.getByLabel("نص العلامة المائية")).toHaveValue(
      "يبقى بعد قتل العملية",
    );
    await page.getByLabel("نص العلامة المائية").fill("حُفظ برمز جديد");
    await page.getByRole("button", { name: "حفظ الإعدادات" }).click();
    await expect(
      page.getByText("حُفظت الإعدادات على هذا الجهاز."),
    ).toBeVisible();
    expect(externalRequests).toEqual([]);
  } finally {
    if (running) await stopApp(running, "SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  }
});
