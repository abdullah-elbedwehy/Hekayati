import { LOOPBACK_HOST } from "../../src/config/defaults.js";
import { deterministicStructuredFixture } from "../../src/providers/mock/deterministic-fixtures.js";
import { createRuntime } from "../../src/server/app.js";
import { seedCreativeProject } from "../helpers/creative-fixtures.js";

const dataDir = process.env.HEKAYATI_DATA_DIR;
if (!dataDir) throw new Error("HEKAYATI_DATA_DIR_REQUIRED");
await seedCreativeProject(dataDir);
const runtime = await createRuntime({
  dataDir,
  enableTestRoutes: true,
  jobs: { pollIntervalMs: 2 },
  providers: { mockStructuredFixture: structuredFixtureWithBlock },
});
const origin = await runtime.start({
  host: LOOPBACK_HOST,
  port: Number(process.env.HEKAYATI_PORT ?? "4317"),
});
console.log(`Hekayati is ready at ${origin}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runtime.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function structuredFixtureWithBlock(
  task: Parameters<typeof deterministicStructuredFixture>[0],
  hash: string,
) {
  if (task.schemaId !== "ReviewFindings")
    return deterministicStructuredFixture(task, hash);
  return {
    schemaVersion: 1,
    findings: [
      {
        scope: "page",
        refId: task.payload.artifactRefs[0],
        pageNumber: 1,
        category: "safety",
        severity: "block",
        excerpt: "ملاحظة اصطناعية",
        note: "تتطلب إقرار المشغّل",
      },
    ],
  };
}
