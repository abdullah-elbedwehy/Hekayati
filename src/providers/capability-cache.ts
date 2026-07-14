import {
  providerCapabilitiesSchema,
  providerIdSchema,
  type ProviderCapabilities,
  type ProviderId,
} from "./contract.js";

interface CacheEntry {
  loadedAt: number;
  value: ProviderCapabilities;
}

export class CapabilityCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.ttlMs = options.ttlMs ?? 300_000;
    if (this.ttlMs <= 0 || this.ttlMs > 300_000) {
      throw new Error("INVALID_CAPABILITY_CACHE_TTL");
    }
  }

  async get(
    providerInput: ProviderId,
    loader: () => Promise<ProviderCapabilities>,
    force = false,
    configurationKey = "default",
  ): Promise<ProviderCapabilities> {
    const provider = providerIdSchema.parse(providerInput);
    const key = cacheKey(provider, configurationKey);
    const existing = this.entries.get(key);
    if (!force && existing && this.now() - existing.loadedAt <= this.ttlMs) {
      return providerCapabilitiesSchema.parse({
        ...existing.value,
        source: "cache",
      });
    }
    const loaded = providerCapabilitiesSchema.parse(await loader());
    if (loaded.providerId !== provider)
      throw new Error("CAPABILITY_PROVIDER_MISMATCH");
    this.entries.set(key, { loadedAt: this.now(), value: loaded });
    return loaded;
  }

  peek(
    providerInput: ProviderId,
    configurationKey = "default",
  ): ProviderCapabilities | null {
    const provider = providerIdSchema.parse(providerInput);
    const existing = this.entries.get(cacheKey(provider, configurationKey));
    if (!existing || this.now() - existing.loadedAt > this.ttlMs) return null;
    return providerCapabilitiesSchema.parse({
      ...existing.value,
      source: "cache",
    });
  }

  invalidate(providerInput?: ProviderId): void {
    if (providerInput === undefined) {
      this.entries.clear();
      return;
    }
    const provider = providerIdSchema.parse(providerInput);
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${provider}\u0000`)) this.entries.delete(key);
    }
  }
}

function cacheKey(provider: ProviderId, configurationKey: string): string {
  if (!configurationKey || configurationKey.length > 1_000) {
    throw new Error("INVALID_CAPABILITY_CONFIGURATION_KEY");
  }
  return `${provider}\u0000${configurationKey}`;
}
