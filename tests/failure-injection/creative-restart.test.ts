import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { httpRequest } from "../helpers/http.js";
import { temporaryDirectory } from "../helpers/temp.js";
import {
  reservePort,
  startApp,
  stopApp,
  type RunningApp,
} from "../e2e/support/running-app.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("creative real-process restart", () => {
  it("recovers a killed sheet view without duplicate jobs or commits", async () => {
    const temp = await temporaryDirectory("hekayati-creative-kill-");
    cleanups.push(temp.cleanup);
    const port = await reservePort();
    let running: RunningApp | null = await startCreative(
      temp.path,
      port,
      "seed",
    );
    await waitFor(async () => {
      const queue = await json(running!.origin, "/api/jobs");
      return (queue.jobs as Array<{ jobType: string; state: string }>).some(
        (job) =>
          job.jobType === "character_sheet_view" && job.state === "running",
      );
    });
    await stopApp(running, "SIGKILL");
    expect(running.child.signalCode).toBe("SIGKILL");
    running = await startCreative(temp.path, port, "resume");
    cleanups.push(async () => {
      if (running) await stopApp(running, "SIGTERM");
    });
    const state = JSON.parse(
      await readFile(join(temp.path, "creative-restart-fixture.json"), "utf8"),
    );
    const snapshot = await waitFor(async () => {
      const current = await json(
        running.origin,
        `/api/creative/projects/${state.projectId}?familyId=${state.scope.familyId}`,
      );
      return (current.sheets as Array<{ status: string }>).some(
        (sheet) => sheet.status === "ready",
      )
        ? current
        : null;
    }, 30_000);
    const queue = await json(running.origin, "/api/jobs");
    const jobs = queue.jobs as Array<{
      id: string;
      jobType: string;
      state: string;
      attempts: number;
    }>;
    const views = jobs.filter((job) => job.jobType === "character_sheet_view");
    expect(views).toHaveLength(5);
    expect(new Set(views.map((job) => job.id)).size).toBe(5);
    expect(views.every((job) => job.state === "succeeded")).toBe(true);
    expect(views.filter((job) => job.attempts === 2)).toHaveLength(1);
    expect(
      jobs.filter((job) => job.jobType === "character_sheet_finalize"),
    ).toHaveLength(1);
    expect(snapshot.sheets).toHaveLength(1);
    expect(snapshot.sheetIntents).toHaveLength(1);
  }, 60_000);

  it("resumes a killed creative graph without duplicate intents, nodes, jobs, or versions", async () => {
    const temp = await temporaryDirectory("hekayati-creative-run-kill-");
    cleanups.push(temp.cleanup);
    const port = await reservePort();
    let running: RunningApp | null = await startCreativeRun(
      temp.path,
      port,
      "seed",
    );
    await waitFor(async () => {
      const queue = await json(running!.origin, "/api/jobs");
      return (queue.jobs as Array<{ jobType: string; state: string }>).some(
        (job) => job.jobType === "story_plan" && job.state === "running",
      );
    }, 30_000);
    await stopApp(running, "SIGKILL");
    expect(running.child.signalCode).toBe("SIGKILL");

    running = await startCreativeRun(temp.path, port, "resume");
    cleanups.push(async () => {
      if (running) await stopApp(running, "SIGTERM");
    });
    const state = JSON.parse(
      await readFile(
        join(temp.path, "creative-run-restart-fixture.json"),
        "utf8",
      ),
    );
    const snapshot = await waitFor(async () => {
      const current = await json(
        running.origin,
        `/api/creative/projects/${state.projectId}?familyId=${state.scope.familyId}`,
      );
      const run = (current.runs as Array<{ id: string; status: string }>).find(
        (item) => item.id === state.runId,
      );
      return run?.status === "internal_review" ? current : null;
    }, 60_000);
    const run = (
      snapshot.runs as Array<{
        id: string;
        nodes: Array<{
          key: string;
          jobId: string | null;
          state: string;
        }>;
      }>
    ).find((item) => item.id === state.runId)!;
    const queue = await json(running.origin, "/api/jobs");
    const runJobIds = new Set(
      run.nodes.flatMap((node) => (node.jobId ? [node.jobId] : [])),
    );
    const runJobs = (
      queue.jobs as Array<{
        id: string;
        jobType: string;
        state: string;
        attempts: number;
        resultRefs: string[];
      }>
    ).filter((job) => runJobIds.has(job.id));
    const materializedNodes = run.nodes.filter((node) => node.jobId !== null);

    expect(snapshot.runs).toHaveLength(1);
    expect(run.nodes).toHaveLength(30);
    expect(new Set(run.nodes.map((node) => node.key)).size).toBe(30);
    expect(materializedNodes).toHaveLength(30);
    expect(new Set(materializedNodes.map((node) => node.jobId)).size).toBe(30);
    expect(runJobs).toHaveLength(30);
    expect(new Set(runJobs.map((job) => job.id)).size).toBe(30);
    expect(
      runJobs.every(
        (job) => job.state === "succeeded" || job.state === "waiting_review",
      ),
    ).toBe(true);
    expect(runJobs.filter((job) => job.jobType === "story_plan")).toEqual([
      expect.objectContaining({ attempts: 2, state: "succeeded" }),
    ]);
    expect(
      runJobs
        .filter((job) => job.jobType !== "story_plan")
        .every((job) => job.attempts <= 1),
    ).toBe(true);
    expect(run.nodes.filter((node) => node.state === "committed")).toHaveLength(
      29,
    );
    expect(snapshot.pages).toHaveLength(16);
    expect(
      (
        snapshot.pages as Array<{
          kind: string;
          currentTextVersionId: string | null;
          currentIllustrationVersionId: string | null;
        }>
      )
        .filter((page) => page.kind === "story")
        .every(
          (page) =>
            page.currentTextVersionId !== null &&
            page.currentIllustrationVersionId !== null,
        ),
    ).toBe(true);
  }, 120_000);
});

function startCreative(dataDir: string, port: number, mode: "seed" | "resume") {
  return startApp(dataDir, port, {
    entryScript: "tests/fixtures/start-creative-app.ts",
    environment: { HEKAYATI_CREATIVE_MODE: mode },
  });
}

function startCreativeRun(
  dataDir: string,
  port: number,
  mode: "seed" | "resume",
) {
  return startApp(dataDir, port, {
    entryScript: "tests/fixtures/start-creative-run-app.ts",
    environment: { HEKAYATI_CREATIVE_MODE: mode },
  });
}

async function json(origin: string, path: string) {
  const response = await httpRequest(origin, path);
  if (response.status !== 200) throw new Error(`HTTP_${response.status}`);
  return JSON.parse(response.body) as Record<string, unknown>;
}

async function waitFor<T>(
  read: () => Promise<T | null | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("CREATIVE_RESTART_TIMEOUT");
}
