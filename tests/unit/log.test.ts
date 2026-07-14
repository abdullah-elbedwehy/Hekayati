import { chmod, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileLogSink,
  Redactor,
  StructuredLogger,
} from "../../src/security/log.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("structured log redaction", () => {
  it("redacts registered values, credential patterns, sensitive keys, errors, and binary data", () => {
    const lines: string[] = [];
    const redactor = new Redactor();
    redactor.register("runtime-csrf-canary");
    redactor.register("private-value-canary");
    const logger = new StructuredLogger((line) => lines.push(line), redactor);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const circularArray: unknown[] = [];
    circularArray.push(circularArray);
    const secretNamedError = new Error("failed with private-value-canary");
    secretNamedError.name = "private-value-canary";

    logger.error("provider runtime-csrf-canary", {
      apiKey: "private-value-canary",
      detail: "Bearer abc.def.ghi and AIza1234567890123456789012345",
      childImageBytes: Buffer.from("sensitive-image"),
      payload: Buffer.from("other-sensitive-binary"),
      ["AIza1234567890123456789012345"]: "safe-value",
      ["private-value-canary"]: "safe-value",
      error: secretNamedError,
      circular,
      circularArray,
    });

    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(lines[0]).not.toContain("runtime-csrf-canary");
    expect(lines[0]).not.toContain("private-value-canary");
    expect(lines[0]).not.toContain("sensitive-image");
    expect(lines[0]).not.toContain("other-sensitive-binary");
    expect(lines[0]).not.toContain("AIza");
    expect(lines[0]).toContain("[REDACTED]");
    expect(lines[0]).toContain("[REDACTED_BINARY]");
  });

  it("creates a private 0600 log file even when an existing mode is broad", async () => {
    const directory = await temporaryDirectory();
    cleanups.push(directory.cleanup);
    const file = join(directory.path, "app.log");
    const logger = new StructuredLogger(createFileLogSink(file));
    await chmod(file, 0o644);
    const redactor = new Redactor();
    redactor.register("runtime-token-in-file");
    const noisyLogger = new StructuredLogger(createFileLogSink(file), redactor);
    logger.info("ready", { safe: true });
    noisyLogger.error("runtime-token-in-file", {
      apiKey: "AIza1234567890123456789012345",
      childImageBytes: Buffer.from("private-child-image-bytes"),
    });

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const corpus = await readFile(file, "utf8");
    expect(corpus).toContain('"event":"ready"');
    expect(corpus).not.toContain("runtime-token-in-file");
    expect(corpus).not.toContain("AIza");
    expect(corpus).not.toContain("private-child-image-bytes");
  });
});
