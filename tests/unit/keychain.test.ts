import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KeychainError, MacOsKeychain } from "../../src/security/keychain.js";
import { Redactor } from "../../src/security/log.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("macOS Keychain transport", () => {
  it("sends new secrets through stdin and never through argv", async () => {
    const fixture = await fakeSecurity();
    const secret = "gemini-secret-canary";
    await fixture.keychain.set("operator", secret);

    const args = await readFile(fixture.args, "utf8");
    expect(args).toContain("add-generic-password");
    expect(args.trim().endsWith("-w")).toBe(true);
    expect(args).not.toContain(secret);
    expect(await readFile(fixture.stdin, "utf8")).toBe(secret);
    expect(fixture.redactor.sanitizeText(secret)).toBe("[REDACTED]");
  });

  it("reads and deletes without exposing raw command failures", async () => {
    const fixture = await fakeSecurity();
    await writeFile(fixture.value, "stored-secret\n", { mode: 0o600 });
    expect(await fixture.keychain.get("operator")).toBe("stored-secret");
    expect(await fixture.keychain.delete("operator")).toBe(true);

    const missing = new MacOsKeychain({
      binary: join(fixture.root, "missing"),
      redactor: new Redactor(),
    });
    await expect(missing.get("operator")).rejects.toMatchObject({
      category: "unavailable",
    });
    await expect(missing.set("operator", "never-in-error")).rejects.not.toThrow(
      "never-in-error",
    );
  });

  it("rejects account values that could alter command arguments", async () => {
    const fixture = await fakeSecurity();
    await expect(
      fixture.keychain.set("operator --evil", "secret"),
    ).rejects.toBeInstanceOf(KeychainError);
  });

  it("kills a hanging credential write at the configured timeout", async () => {
    const directory = await temporaryDirectory("hekayati-keychain-timeout-");
    cleanups.push(directory.cleanup);
    const binary = join(directory.path, "hanging-security");
    await writeFile(
      binary,
      `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => undefined, 10_000);
`,
      { mode: 0o700 },
    );
    const keychain = new MacOsKeychain({
      binary,
      timeoutMs: 50,
      redactor: new Redactor(),
    });

    await expect(
      keychain.set("operator", "timeout-secret"),
    ).rejects.toMatchObject({ category: "write_failed" });
  });

  it("normalizes an executable that exits before consuming stdin", async () => {
    const directory = await temporaryDirectory("hekayati-keychain-exit-");
    cleanups.push(directory.cleanup);
    const binary = join(directory.path, "exiting-security");
    await writeFile(binary, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
    const redactor = new Redactor();
    const keychain = new MacOsKeychain({ binary, redactor, timeoutMs: 500 });

    await expect(
      keychain.set("operator", "early-exit-secret"),
    ).rejects.toMatchObject({ category: "write_failed" });
    expect(redactor.sanitizeText("early-exit-secret")).toBe("[REDACTED]");
  });
});

async function fakeSecurity() {
  const directory = await temporaryDirectory("hekayati-keychain-");
  cleanups.push(directory.cleanup);
  const binary = join(directory.path, "security");
  const args = join(directory.path, "args");
  const stdin = join(directory.path, "stdin");
  const value = join(directory.path, "value");
  const script = `#!/bin/sh
printf '%s\\n' "$@" > "$TRACE_ARGS"
case "$1" in
  add-generic-password) IFS= read -r input; printf '%s' "$input" > "$TRACE_STDIN" ;;
  find-generic-password) cat "$TRACE_VALUE" ;;
  delete-generic-password) exit 0 ;;
  *) exit 1 ;;
esac
`;
  await writeFile(binary, script, { mode: 0o700 });
  await chmod(binary, 0o700);
  process.env.TRACE_ARGS = args;
  process.env.TRACE_STDIN = stdin;
  process.env.TRACE_VALUE = value;
  const redactor = new Redactor();
  return {
    root: directory.path,
    args,
    stdin,
    value,
    redactor,
    keychain: new MacOsKeychain({ binary, timeoutMs: 1000, redactor }),
  };
}
