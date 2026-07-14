import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LOOPBACK_HOST } from "../../src/config/defaults.js";
import { MockFaultScript } from "../../src/providers/mock/fault-script.js";
import { createRuntime } from "../../src/server/app.js";
import {
  seedCreativeProject,
  waitForValue,
} from "../helpers/creative-fixtures.js";

const dataDir = process.env.HEKAYATI_DATA_DIR;
if (!dataDir) throw new Error("HEKAYATI_DATA_DIR_REQUIRED");
const mode = process.env.HEKAYATI_CREATIVE_MODE ?? "resume";
const statePath = join(dataDir, "creative-run-restart-fixture.json");
const state =
  mode === "seed"
    ? await seedCreativeProject(dataDir, "-restart")
    : JSON.parse(await readFile(statePath, "utf8"));
const runtime = await createRuntime({
  dataDir,
  enableTestRoutes: true,
  jobs: { pollIntervalMs: 2, concurrencyPerProvider: 1 },
  providers:
    mode === "seed"
      ? {
          mockFaults: new MockFaultScript([
            { operation: "structured", latencyMs: 60_000 },
          ]),
        }
      : undefined,
});
const origin = await runtime.start({
  host: LOOPBACK_HOST,
  port: Number(process.env.HEKAYATI_PORT ?? "4317"),
});

if (mode === "seed") {
  const startedSheet = runtime.creative.sheetPipeline.start(
    state.scope,
    state.projectId,
    {
      characterId: state.characterId,
      expectedProjectVersionId: state.projectVersionId,
    },
  );
  const readyIntent = await waitForValue(() => {
    const intent = runtime.creative.sheets.getIntent(startedSheet.intent.id);
    return intent.status === "ready" && intent.approvalGateJobId
      ? intent
      : null;
  });
  const sheet = runtime.creative.sheets.getSheet(readyIntent.sheetId);
  const gate = runtime.jobs.scheduler.get(readyIntent.approvalGateJobId!);
  if (!gate) throw new Error("CREATIVE_RESTART_GATE_MISSING");
  runtime.creative.sheets.approveSheet({
    sheetId: sheet.id,
    expectedSheetRevision: sheet.revision,
    intentId: readyIntent.id,
    expectedIntentRevision: readyIntent.revision,
    gateJobId: gate.id,
    expectedGateRevision: gate.revision,
    notes: "اعتماد اصطناعي لاختبار الاستئناف",
  });
  const startedRun = runtime.creative.pipeline.startRun(
    state.scope,
    state.projectId,
    {
      expectedProjectVersionId: state.projectVersionId,
      expectedStoryVersionId: state.storyVersionId,
    },
  );
  await writeFile(
    statePath,
    JSON.stringify({ ...state, runId: startedRun.run.id }),
    { encoding: "utf8", mode: 0o600 },
  );
}

console.log(`Hekayati is ready at ${origin}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runtime.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
