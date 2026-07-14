import {
  providerIdSchema,
  type AiProvider,
  type ProviderId,
} from "./contract.js";

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, AiProvider>();

  constructor(providers: readonly AiProvider[]) {
    for (const provider of providers) {
      const id = providerIdSchema.parse(provider.providerId);
      if (this.providers.has(id)) throw new Error("DUPLICATE_PROVIDER_ID");
      this.providers.set(id, provider);
    }
  }

  get(providerInput: unknown): AiProvider {
    const parsed = providerIdSchema.safeParse(providerInput);
    if (!parsed.success) throw new Error("INVALID_PROVIDER_ID");
    const provider = this.providers.get(parsed.data);
    if (!provider) throw new Error("PROVIDER_NOT_REGISTERED");
    return provider;
  }

  has(providerInput: unknown): boolean {
    const parsed = providerIdSchema.safeParse(providerInput);
    return parsed.success && this.providers.has(parsed.data);
  }
}
