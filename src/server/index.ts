import { execFile } from "node:child_process";

import { DEFAULT_PORT, LOOPBACK_HOST } from "../config/defaults.js";
import { createRuntime } from "./app.js";
import { parsePort } from "./startup/bind.js";

const runtime = await createRuntime({
  enableTestRoutes: process.env.HEKAYATI_TEST_ROUTES === "1",
});

const origin = await runtime.start({
  host: process.env.HEKAYATI_HOST ?? LOOPBACK_HOST,
  port: parsePort(process.env.HEKAYATI_PORT, DEFAULT_PORT),
});

console.log(`Hekayati is ready at ${origin}`);

if (process.env.HEKAYATI_NO_OPEN !== "1") {
  execFile("/usr/bin/open", [origin], { timeout: 5000 }, (error) => {
    if (error)
      console.warn(
        "Could not open the browser automatically. Use the URL above.",
      );
  });
}

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runtime.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
