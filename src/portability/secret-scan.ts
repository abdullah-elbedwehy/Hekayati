import { TextDecoder } from "node:util";
import type { Readable } from "node:stream";

import type { SecretRegistry } from "../security/secret-registry.js";

export type SecretFindingCategory =
  | "gemini_key"
  | "bearer_credential"
  | "private_key"
  | "codex_auth"
  | "keychain_dump"
  | "cookie_or_token"
  | "seeded_canary"
  | "registered_or_known_secret";

export interface SecretScanFinding {
  category: SecretFindingCategory;
  entry: string;
}

const fixedPatterns: ReadonlyArray<{
  category: Exclude<SecretFindingCategory, "registered_or_known_secret">;
  pattern: RegExp;
}> = [
  { category: "gemini_key", pattern: /AIza[0-9A-Za-z_-]{20,}/ },
  {
    category: "bearer_credential",
    pattern: /(?:Authorization\s*:\s*)?Bearer\s+[0-9A-Za-z._~+/-]+=*/i,
  },
  {
    category: "private_key",
    pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
  },
  {
    category: "codex_auth",
    pattern:
      /(?:\.codex[/\\]auth\.json|"(?:access_token|refresh_token|id_token)"\s*:|(?:OPENAI|CODEX)_API_KEY\s*=)/i,
  },
  {
    category: "keychain_dump",
    pattern:
      /(?:security\s+(?:find-generic-password|dump-keychain)|keychain[_ -]dump)/i,
  },
  {
    category: "cookie_or_token",
    pattern:
      /(?:(?:^|[\r\n])(?:Cookie|Set-Cookie)\s*:|["']?(?:cookie|token|csrf[_-]?token|session[_-]?token)["']?\s*[:=])/i,
  },
  {
    category: "seeded_canary",
    pattern: /HEKAYATI[_-]SECRET[_-]CANARY/i,
  },
];

export class SecretReleaseGate {
  constructor(private readonly registry: SecretRegistry) {}

  scanEntryName(entry: string): SecretScanFinding | null {
    return this.scanText(entry, entry);
  }

  async scanStream(
    entry: string,
    stream: Readable,
  ): Promise<SecretScanFinding | null> {
    const decoder = new TextDecoder("utf-8");
    const overlap = this.registry.streamingOverlapCharacters();
    let carry = "";

    for await (const chunk of stream) {
      const text =
        carry +
        decoder.decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), {
          stream: true,
        });
      const finding = this.scanText(entry, text);
      if (finding) return finding;
      carry = text.slice(-overlap);
    }

    return this.scanText(entry, carry + decoder.decode());
  }

  private scanText(entry: string, value: string): SecretScanFinding | null {
    const findingEntry = safeFindingEntry(entry);
    for (const candidate of fixedPatterns) {
      if (candidate.pattern.test(value))
        return { category: candidate.category, entry: findingEntry };
    }
    return this.registry.containsSecretText(value)
      ? { category: "registered_or_known_secret", entry: findingEntry }
      : null;
  }
}

function safeFindingEntry(entry: string): string {
  if (
    Buffer.byteLength(entry, "utf8") > 240 ||
    entry.startsWith("/") ||
    entry.includes("\\") ||
    entry.includes("\0") ||
    entry.split("/").some((part) => part === "..")
  )
    return "untrusted-entry";
  return entry;
}
