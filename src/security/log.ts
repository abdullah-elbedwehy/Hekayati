import { appendFileSync, chmodSync, closeSync, openSync } from "node:fs";

import { SecretRegistry } from "./secret-registry.js";

const BINARY = "[REDACTED_BINARY]";
const sensitiveKey =
  /(authorization|cookie|credential|password|secret|token|api.?key|image|bytes|base64)/i;

export type LogLevel = "info" | "warn" | "error";
export type LogSink = (line: string) => void;

export class Redactor {
  constructor(readonly secrets = new SecretRegistry()) {}

  register(secret: string): void {
    this.secrets.register(secret);
  }

  sanitize(value: unknown): unknown {
    return this.walk(value, new WeakSet<object>());
  }

  sanitizeText(value: string): string {
    return this.secrets.redactText(value);
  }

  private walk(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.sanitizeText(value);
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return BINARY;
    if (value instanceof Error)
      return {
        name: this.sanitizeText(value.name),
        message: this.sanitizeText(value.message),
      };
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item, seen));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        this.sanitizeText(key),
        sensitiveKey.test(key) ? "[REDACTED]" : this.walk(item, seen),
      ]),
    );
  }
}

export class StructuredLogger {
  constructor(
    private readonly sink: LogSink,
    readonly redactor = new Redactor(),
  ) {}

  info(event: string, data: Record<string, unknown> = {}): void {
    this.write("info", event, data);
  }

  warn(event: string, data: Record<string, unknown> = {}): void {
    this.write("warn", event, data);
  }

  error(event: string, data: Record<string, unknown> = {}): void {
    this.write("error", event, data);
  }

  private write(
    level: LogLevel,
    event: string,
    data: Record<string, unknown>,
  ): void {
    this.sink(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event: this.redactor.sanitizeText(event),
        data: this.redactor.sanitize(data),
      })}\n`,
    );
  }
}

export function createFileLogSink(file: string): LogSink {
  const descriptor = openSync(file, "a", 0o600);
  closeSync(descriptor);
  chmodSync(file, 0o600);
  return (line) =>
    appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
}
