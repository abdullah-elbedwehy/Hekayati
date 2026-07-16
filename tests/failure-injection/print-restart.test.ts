import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStore } from "../../src/assets/asset-store.js";
import { resolveDataPaths } from "../../src/config/paths.js";
import { PrintRepositories } from "../../src/domain/print/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { JobRepository } from "../../src/jobs/repository.js";
import {
  reservePort,
  startApp,
  stopApp,
  type RunningApp,
} from "../e2e/support/running-app.js";
import { temporaryDirectory } from "../helpers/temp.js";

const STAGES = [
  "interior_render",
  "cover_render",
  "cmyk_conversion",
  "validation",
  "after_temp_sync",
  "after_rename_before_db",
] as const;
type FaultStage = (typeof STAGES)[number];
const FAULT_MARKER_TIMEOUT_MS = 100_000;
const RESTART_CASE_TIMEOUT_MS = 180_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("print-stage process restart", () => {
  it.each(STAGES)(
    "recovers idempotently after SIGKILL at %s",
    async (stage) => {
      const directory = await temporaryDirectory(`hekayati-print-${stage}-`);
      cleanups.push(directory.cleanup);
      const port = await reservePort();
      let running: RunningApp | null = await startPrintProcess(
        directory.path,
        port,
        stage,
      );
      cleanups.push(async () => {
        if (running) await stopApp(running, "SIGKILL");
      });

      await waitForFault(directory.path, stage, running);
      await stopApp(running, "SIGKILL");
      expect(running.child.signalCode).toBe("SIGKILL");

      running = await startApp(directory.path, port, {
        entryScript: "tests/fixtures/start-print-app.ts",
        environment: {
          HEKAYATI_PRINT_MODE: "resume",
          HEKAYATI_PRINT_FAST_FIXTURE: "1",
        },
      });
      const state = await fixtureState(directory.path);
      const expectedState =
        stage === "cmyk_conversion" ? "converted_proof_pending" : "deliverable";
      await waitForRunState(
        running.origin,
        state,
        expectedState,
        stage === "cmyk_conversion" ? 60_000 : 45_000,
      );
      await stopApp(running, "SIGTERM");
      running = null;

      await expectRecoveredState(directory.path, stage, expectedState);
    },
    RESTART_CASE_TIMEOUT_MS,
  );
});

function startPrintProcess(
  directory: string,
  port: number,
  stage: FaultStage,
): Promise<RunningApp> {
  return startApp(directory, port, {
    entryScript: "tests/fixtures/start-print-app.ts",
    environment: {
      HEKAYATI_PRINT_MODE: "seed",
      HEKAYATI_PRINT_FAST_FIXTURE: "1",
      HEKAYATI_PRINT_AUTOSTART: stage === "cmyk_conversion" ? "cmyk" : "rgb",
      HEKAYATI_PRINT_FAULT_STAGE: stage,
    },
  });
}

interface FixtureState {
  projectId: string;
  scope: { customerId: string; familyId: string };
}

function fixtureState(directory: string): Promise<FixtureState> {
  return readFile(join(directory, "print-e2e-fixture.json"), "utf8").then(
    (value) => JSON.parse(value) as FixtureState,
  );
}

async function waitForFault(
  directory: string,
  stage: FaultStage,
  running: RunningApp,
): Promise<void> {
  const marker = join(directory, `print-fault-${stage}.ready`);
  const failure = join(directory, "print-autostart.failed");
  // The child already gives layout materialization 90 seconds before writing
  // its bounded failure marker. The parent must outlive that inner deadline so
  // it can surface the real failure instead of masking it as a marker timeout.
  const deadline = Date.now() + FAULT_MARKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await exists(marker)) return;
    if (await exists(failure))
      throw new Error(
        `PRINT_AUTOSTART_FAILED ${await readFile(failure, "utf8")}`,
      );
    if (running.child.exitCode !== null || running.child.signalCode !== null)
      throw new Error("PRINT_FAULT_PROCESS_EXITED");
    await delay(10);
  }
  throw new Error(`PRINT_FAULT_MARKER_TIMEOUT ${stage}`);
}

async function waitForRunState(
  origin: string,
  state: FixtureState,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${origin}/api/print/projects/${state.projectId}?familyId=${state.scope.familyId}`,
    );
    const projection = (await response.json()) as {
      run?: { state?: string } | null;
      report?: { findings?: Array<{ code?: string; actual?: unknown }> } | null;
    };
    const current = projection.run?.state;
    if (current === expected) return;
    if (["blocked", "rejected", "stale"].includes(current ?? ""))
      throw new Error(
        `PRINT_RESTART_TERMINAL_${current} ${JSON.stringify(
          projection.report?.findings ?? [],
        ).slice(0, 1_000)}`,
      );
    await delay(20);
  }
  throw new Error(`PRINT_RESTART_TIMEOUT ${expected}`);
}

async function expectRecoveredState(
  directory: string,
  stage: FaultStage,
  expectedState: string,
): Promise<void> {
  const paths = resolveDataPaths(directory);
  const store = new DocumentStore(paths.database);
  try {
    const print = new PrintRepositories(store);
    const jobs = new JobRepository(store).list();
    const assets = new AssetStore(store, paths.assets);
    const [run] = print.runs.list();
    expect(print.runs.list()).toHaveLength(1);
    expect(run?.state).toBe(expectedState);
    const artifacts = print.artifacts
      .list()
      .filter((artifact) => artifact.runId === run?.id);
    expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      "cover",
      "interior",
    ]);
    expect(new Set(artifacts.map((artifact) => artifact.id)).size).toBe(2);
    expect(print.preflightReports.list()).toHaveLength(1);
    expect(print.proofBundles.list()).toHaveLength(
      stage === "cmyk_conversion" ? 1 : 0,
    );
    expect(
      jobs.filter(
        (job) =>
          job.request.kind === "human_gate" &&
          job.request.gateKind === "print_converted_proof",
      ),
    ).toHaveLength(stage === "cmyk_conversion" ? 1 : 0);
    expect(retriedAtBoundary(jobs, stage)).toBe(true);
    for (const artifact of artifacts)
      await expect(
        assets.verifyIntegrity(artifact.assetId),
      ).resolves.toMatchObject({
        status: "healthy",
        expectedSha256: artifact.checksum,
      });
    expect(await assets.garbageCollectOrphans()).toEqual([]);
  } finally {
    store.close();
  }
}

function retriedAtBoundary(
  jobs: ReturnType<JobRepository["list"]>,
  stage: FaultStage,
): boolean {
  const types =
    stage === "interior_render"
      ? ["print_interior"]
      : stage === "cover_render"
        ? ["print_cover"]
        : stage === "validation"
          ? ["print_preflight"]
          : ["print_interior", "print_cover"];
  return jobs.some((job) => types.includes(job.jobType) && job.attempts >= 2);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
