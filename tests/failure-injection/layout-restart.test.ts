import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDataPaths } from "../../src/config/paths.js";
import { LayoutRepositories } from "../../src/domain/layout/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  reservePort,
  startApp,
  stopApp,
  type RunningApp,
} from "../e2e/support/running-app.js";
import { httpRequest } from "../helpers/http.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("layout real-process restart", () => {
  it("recovers a killed layout graph without duplicate layouts, previews, or approval gates", async () => {
    const temp = await temporaryDirectory("hekayati-layout-kill-");
    cleanups.push(temp.cleanup);
    const port = await reservePort();
    let running: RunningApp | null = await startLayout(temp.path, port, "seed");
    await waitFor(async () => {
      const queue = await json(running!.origin, "/api/jobs");
      return jobs(queue).some(
        (job) => job.jobType === "page_layout" && job.state === "running",
      );
    });
    await stopApp(running, "SIGKILL");
    expect(running.child.signalCode).toBe("SIGKILL");

    running = await startLayout(temp.path, port, "resume");
    cleanups.push(async () => {
      if (running) await stopApp(running, "SIGTERM");
    });
    const state = JSON.parse(
      await readFile(join(temp.path, "layout-restart-fixture.json"), "utf8"),
    ) as { projectId: string; scope: { familyId: string } };
    const snapshot = await waitFor(async () => {
      const response = await json(
        running!.origin,
        `/api/layout/projects/${state.projectId}?familyId=${state.scope.familyId}`,
      );
      return response.workflow &&
        (response.workflow as { state: string }).state === "ready"
        ? response
        : null;
    }, 90_000);
    const queue = await json(running.origin, "/api/jobs");
    const allJobs = jobs(queue);
    const layouts = allJobs.filter((job) => job.jobType === "page_layout");
    const previews = allJobs.filter((job) => job.jobType === "preview_pdf");
    const gates = allJobs.filter(
      (job) => job.jobType === "human_gate" && job.state === "waiting_review",
    );
    expect(layouts).toHaveLength(16);
    expect(new Set(layouts.map((job) => job.id)).size).toBe(16);
    expect(layouts.every((job) => job.state === "succeeded")).toBe(true);
    expect(layouts.filter((job) => job.attempts === 2)).toHaveLength(1);
    expect(previews).toEqual([
      expect.objectContaining({ state: "succeeded", attempts: 1 }),
    ]);
    expect(gates).toHaveLength(1);
    expect(snapshot).toMatchObject({
      preview: { status: "ready" },
      approval: { state: "ready_to_send" },
    });

    await stopApp(running, "SIGTERM");
    running = null;
    assertPersistedCardinality(temp.path);
  }, 120_000);

  it("recovers a process killed inside preview rendering and commits one indexed proof", async () => {
    const temp = await temporaryDirectory("hekayati-preview-kill-");
    cleanups.push(temp.cleanup);
    const port = await reservePort();
    let running: RunningApp | null = await startLayout(temp.path, port, "seed");
    await waitFor(async () => {
      const queue = await json(running!.origin, "/api/jobs");
      return jobs(queue).some(
        (job) => job.jobType === "preview_pdf" && job.state === "running",
      );
    }, 90_000);
    await stopApp(running, "SIGKILL");
    expect(running.child.signalCode).toBe("SIGKILL");

    running = await startLayout(temp.path, port, "resume");
    cleanups.push(async () => {
      if (running) await stopApp(running, "SIGTERM");
    });
    const state = JSON.parse(
      await readFile(join(temp.path, "layout-restart-fixture.json"), "utf8"),
    ) as { projectId: string; scope: { familyId: string } };
    await waitFor(async () => {
      const snapshot = await json(
        running!.origin,
        `/api/layout/projects/${state.projectId}?familyId=${state.scope.familyId}`,
      );
      return snapshot.workflow &&
        (snapshot.workflow as { state: string }).state === "ready"
        ? snapshot
        : null;
    }, 90_000);
    const queue = await json(running.origin, "/api/jobs");
    const allJobs = jobs(queue);
    expect(allJobs.filter((job) => job.jobType === "page_layout")).toHaveLength(
      16,
    );
    expect(
      allJobs
        .filter((job) => job.jobType === "page_layout")
        .every((job) => job.attempts === 1 && job.state === "succeeded"),
    ).toBe(true);
    expect(allJobs.filter((job) => job.jobType === "preview_pdf")).toEqual([
      expect.objectContaining({ attempts: 2, state: "succeeded" }),
    ]);
    expect(
      allJobs.filter(
        (job) => job.jobType === "human_gate" && job.state === "waiting_review",
      ),
    ).toHaveLength(1);

    await stopApp(running, "SIGTERM");
    running = null;
    assertPersistedCardinality(temp.path);
  }, 120_000);
});

interface JobSnapshot {
  id: string;
  jobType: string;
  state: string;
  attempts: number;
}

function startLayout(dataDir: string, port: number, mode: "seed" | "resume") {
  return startApp(dataDir, port, {
    entryScript: "tests/fixtures/start-layout-app.ts",
    environment: { HEKAYATI_LAYOUT_MODE: mode },
  });
}

function jobs(queue: Record<string, unknown>): JobSnapshot[] {
  return queue.jobs as JobSnapshot[];
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
  throw new Error("LAYOUT_RESTART_TIMEOUT");
}

function assertPersistedCardinality(dataDir: string): void {
  const store = new DocumentStore(resolveDataPaths(dataDir).database);
  try {
    const layout = new LayoutRepositories(store);
    expect(layout.pageLayoutHeads.list()).toHaveLength(16);
    expect(layout.layoutVersions.list()).toHaveLength(16);
    expect(layout.previewOutputs.list()).toHaveLength(1);
    expect(layout.bookApprovalCycles.list()).toHaveLength(1);
  } finally {
    store.close();
  }
}
