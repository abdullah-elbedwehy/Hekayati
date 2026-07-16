const REDACTED = "[REDACTED]";
const knownSecretPatterns = [
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Bearer\s+[0-9A-Za-z._~+/-]+=*/gi,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
];

export class SecretPersistenceError extends Error {
  constructor() {
    super("SECRET_PERSISTENCE_FORBIDDEN");
    this.name = "SecretPersistenceError";
  }
}

export class SecretRegistry {
  private readonly exactSecrets = new Set<string>();

  register(secret: string): void {
    if (secret.length >= 8) this.exactSecrets.add(secret);
  }

  redactText(value: string): string {
    let output = value;
    for (const secret of this.exactSecrets)
      output = output.split(secret).join(REDACTED);
    for (const pattern of knownSecretPatterns)
      output = output.replace(pattern, REDACTED);
    return output;
  }

  containsSecretText(value: string): boolean {
    for (const secret of this.exactSecrets) {
      if (value.includes(secret)) return true;
    }
    return knownSecretPatterns.some((pattern) => matches(pattern, value));
  }

  streamingOverlapCharacters(minimum = 512): number {
    let longest = minimum + 1;
    for (const secret of this.exactSecrets)
      longest = Math.max(longest, secret.length);
    return longest - 1;
  }

  assertSafeForPersistence(value: unknown): void {
    if (this.containsSecretMaterial(value, new WeakSet<object>()))
      throw new SecretPersistenceError();
  }

  assertSafeBinaryPayload(value: Uint8Array): void {
    if (this.containsSecretText(Buffer.from(value).toString("utf8")))
      throw new SecretPersistenceError();
  }

  private containsSecretMaterial(
    value: unknown,
    seen: WeakSet<object>,
  ): boolean {
    if (typeof value === "string") return this.containsSecretText(value);
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return true;
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return true;
    seen.add(value);
    const contains = Array.isArray(value)
      ? value.some((item) => this.containsSecretMaterial(item, seen))
      : Object.entries(value).some(
          ([key, item]) =>
            this.containsSecretText(key) ||
            this.containsSecretMaterial(item, seen),
        );
    seen.delete(value);
    return contains;
  }
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const found = pattern.test(value);
  pattern.lastIndex = 0;
  return found;
}
