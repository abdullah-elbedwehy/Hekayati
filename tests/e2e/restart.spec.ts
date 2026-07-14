import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

interface RunningApp {
  child: ChildProcess;
  origin: string;
}

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

function startApp(dataDir: string, port: number): Promise<RunningApp> {
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/server/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HEKAYATI_DATA_DIR: dataDir,
        HEKAYATI_PORT: String(port),
        HEKAYATI_NO_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return waitUntilReady(child, origin);
}

function waitUntilReady(
  child: ChildProcess,
  origin: string,
): Promise<RunningApp> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`APP_START_TIMEOUT ${stderr.slice(-500)}`));
    }, 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(`Hekayati is ready at ${origin}`)) {
        clearTimeout(timer);
        resolve({ child, origin });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `APP_EXITED ${String(code)} ${String(signal)} ${stderr.slice(-500)}`,
        ),
      );
    });
  });
}

async function stopApp(
  running: RunningApp,
  signal: "SIGKILL" | "SIGTERM",
): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null)
    return;
  const exited = once(running.child, "exit");
  running.child.kill(signal);
  await exited;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NO_TEST_PORT");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
