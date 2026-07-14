import { z } from "zod";

import type { Redactor } from "../../security/log.js";

const GEMINI_ACCOUNT = "operator";
export const GEMINI_CREDENTIAL_MASK = "••••••••";

const credentialInputSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 512),
  })
  .strict();

export interface KeychainPort {
  set(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string | null>;
  delete(account: string): Promise<boolean>;
}

export interface CredentialStatus {
  present: boolean;
  masked: typeof GEMINI_CREDENTIAL_MASK | null;
}

export class GeminiCredentialService {
  constructor(
    private readonly keychain: KeychainPort,
    private readonly redactor: Pick<Redactor, "register">,
    private readonly onChange: () => void = () => undefined,
  ) {}

  async status(): Promise<CredentialStatus> {
    const key = await this.keychain.get(GEMINI_ACCOUNT);
    if (key) this.redactor.register(key);
    return key ? presentStatus() : absentStatus();
  }

  async save(input: unknown): Promise<CredentialStatus> {
    const { key } = credentialInputSchema.parse(input);
    this.redactor.register(key);
    await this.keychain.set(GEMINI_ACCOUNT, key);
    this.onChange();
    return presentStatus();
  }

  async delete(): Promise<CredentialStatus> {
    await this.keychain.delete(GEMINI_ACCOUNT);
    this.onChange();
    return absentStatus();
  }

  async read(): Promise<string | null> {
    const key = await this.keychain.get(GEMINI_ACCOUNT);
    if (key) this.redactor.register(key);
    return key;
  }
}

function presentStatus(): CredentialStatus {
  return { present: true, masked: GEMINI_CREDENTIAL_MASK };
}

function absentStatus(): CredentialStatus {
  return { present: false, masked: null };
}
