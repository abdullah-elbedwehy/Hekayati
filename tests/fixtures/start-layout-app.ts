import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LOOPBACK_HOST } from "../../src/config/defaults.js";
import { createRuntime } from "../../src/server/app.js";
import { createLayoutWorkflowFixture } from "../helpers/layout-workflow-fixture.js";

const dataDir = process.env.HEKAYATI_DATA_DIR;
if (!dataDir) throw new Error("HEKAYATI_DATA_DIR_REQUIRED");
const mode = process.env.HEKAYATI_LAYOUT_MODE ?? "resume";
const statePath = join(dataDir, "layout-restart-fixture.json");

const state =
  mode === "seed"
    ? await seedFixture(dataDir, statePath)
    : JSON.parse(await readFile(statePath, "utf8"));
const runtime = await createRuntime({
  dataDir,
  enableTestRoutes: true,
  jobs: {
    pollIntervalMs: 2,
    maxWorkers: 1,
    heartbeatIntervalMs: 25,
    leaseTtlMs: 250,
  },
});
const origin = await runtime.start({
  host: LOOPBACK_HOST,
  port: Number(process.env.HEKAYATI_PORT ?? "4317"),
});
if (mode === "seed") runtime.layout.workflow.start(state.projectId);
console.log(`Hekayati is ready at ${origin}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runtime.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

async function seedFixture(dataDirectory: string, stateFile: string) {
  const fixture = await createLayoutWorkflowFixture(dataDirectory);
  const state = fixture.seed;
  fixture.store.close();
  await writeFile(stateFile, JSON.stringify(state), {
    encoding: "utf8",
    mode: 0o600,
  });
  return state;
}
