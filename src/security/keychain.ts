import { execFile, spawn } from "node:child_process";

import type { Redactor } from "./log.js";

const ACCOUNT_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

export interface KeychainOptions {
  redactor: Pick<Redactor, "register">;
  binary?: string;
  service?: string;
  timeoutMs?: number;
}

interface CommandError extends Error {
  code?: number | string;
}

export class KeychainError extends Error {
  constructor(
    readonly category:
      "unavailable" | "write_failed" | "read_failed" | "delete_failed",
  ) {
    super(`KEYCHAIN_${category.toUpperCase()}`);
    this.name = "KeychainError";
  }
}

export class MacOsKeychain {
  private readonly binary: string;
  private readonly service: string;
  private readonly timeoutMs: number;
  private readonly redactor: Pick<Redactor, "register">;

  constructor(options: KeychainOptions) {
    this.binary = options.binary ?? "/usr/bin/security";
    this.service = options.service ?? "com.hekayati.gemini-api-key";
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.redactor = options.redactor;
  }

  async set(account: string, secret: string): Promise<void> {
    assertAccount(account);
    if (!secret) throw new KeychainError("write_failed");
    this.redactor.register(secret);
    const args = [
      "add-generic-password",
      "-U",
      "-a",
      account,
      "-s",
      this.service,
      "-w",
    ];
    await this.writeThroughPrompt(args, secret);
  }

  async get(account: string): Promise<string | null> {
    assertAccount(account);
    try {
      const { stdout } = await this.run([
        "find-generic-password",
        "-a",
        account,
        "-s",
        this.service,
        "-w",
      ]);
      const secret = stdout.replace(/\r?\n$/, "");
      this.redactor.register(secret);
      return secret;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw mapCommandError(error, "read_failed");
    }
  }

  async delete(account: string): Promise<boolean> {
    assertAccount(account);
    try {
      await this.run([
        "delete-generic-password",
        "-a",
        account,
        "-s",
        this.service,
      ]);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw mapCommandError(error, "delete_failed");
    }
  }

  private async writeThroughPrompt(
    args: string[],
    secret: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.binary, args, {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
      });
      let settled = false;
      const timer = setTimeout(() => child.kill("SIGKILL"), this.timeoutMs);
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(mapCommandError(error, "write_failed"));
      };
      child.once("error", fail);
      child.stdin.once("error", fail);
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new KeychainError("write_failed"));
      });
      child.stdin.end(`${secret}\n`, "utf8");
    });
  }

  private async run(args: string[]): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        args,
        { timeout: this.timeoutMs, maxBuffer: 64 * 1024, encoding: "utf8" },
        (error, stdout) => {
          if (error)
            reject(
              error instanceof Error
                ? error
                : new Error("KEYCHAIN_COMMAND_FAILED"),
            );
          else resolve({ stdout });
        },
      );
    });
  }
}

function assertAccount(account: string): void {
  if (!ACCOUNT_PATTERN.test(account)) throw new KeychainError("unavailable");
}

function isNotFound(error: unknown): boolean {
  const code = (error as CommandError | undefined)?.code;
  return code === 44 || code === "44";
}

function mapCommandError(
  error: unknown,
  fallback: KeychainError["category"],
): KeychainError {
  const code = (error as CommandError | undefined)?.code;
  return code === "ENOENT" || code === "EACCES"
    ? new KeychainError("unavailable")
    : new KeychainError(fallback);
}
