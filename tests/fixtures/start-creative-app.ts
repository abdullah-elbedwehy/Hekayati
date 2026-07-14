import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LOOPBACK_HOST } from "../../src/config/defaults.js";
import { MockFaultScript } from "../../src/providers/mock/fault-script.js";
import { createRuntime } from "../../src/server/app.js";
import { seedCreativeProject } from "../helpers/creative-fixtures.js";

const dataDir = process.env.HEKAYATI_DATA_DIR;
if (!dataDir) throw new Error("HEKAYATI_DATA_DIR_REQUIRED");
const mode = process.env.HEKAYATI_CREATIVE_MODE ?? "resume";
const statePath = join(dataDir, "creative-restart-fixture.json");
const state =
  mode === "seed"
    ? await seedCreativeProject(dataDir)
    : JSON.parse(await readFile(statePath, "utf8"));
const runtime = await createRuntime({
  dataDir,
  enableTestRoutes: true,
  jobs: { pollIntervalMs: 2, concurrencyPerProvider: 1 },
  providers:
    mode === "seed"
      ? {
          mockFaults: new MockFaultScript([
            { operation: "image", latencyMs: 60_000 },
          ]),
        }
      : undefined,
});
const origin = await runtime.start({
  host: LOOPBACK_HOST,
  port: Number(process.env.HEKAYATI_PORT ?? "4317"),
});
if (mode === "seed") {
  const started = runtime.creative.sheetPipeline.start(
    state.scope,
    state.projectId,
    {
      characterId: state.characterId,
      expectedProjectVersionId: state.projectVersionId,
    },
  );
  await writeFile(
    statePath,
    JSON.stringify({ ...state, intentId: started.intent.id }),
    {
      encoding: "utf8",
      mode: 0o600,
    },
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
