import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

export interface RunningApp {
  child: ChildProcess;
  origin: string;
}

export function startApp(dataDir: string, port: number): Promise<RunningApp> {
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

export async function stopApp(
  running: RunningApp,
  signal: "SIGKILL" | "SIGTERM",
): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null)
    return;
  const exited = once(running.child, "exit");
  running.child.kill(signal);
  await exited;
}

export async function reservePort(): Promise<number> {
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
