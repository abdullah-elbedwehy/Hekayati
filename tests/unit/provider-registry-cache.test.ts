import { describe, expect, it } from "vitest";

import type { ProviderCapabilities } from "../../src/providers/contract.js";
import { CapabilityCache } from "../../src/providers/capability-cache.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { MockProvider } from "../../src/providers/mock/adapter.js";

describe("provider capability cache and registry", () => {
  it("expires at five minutes, marks cache reads, and honors force", async () => {
    let now = 1_000;
    let loads = 0;
    const cache = new CapabilityCache({ now: () => now, ttlMs: 300_000 });
    const load = async (): Promise<ProviderCapabilities> => {
      loads += 1;
      return fixtureCapabilities(new Date(now).toISOString());
    };
    const first = await cache.get("mock", load);
    const cached = await cache.get("mock", load);
    expect(first.source).toBe("fixture");
    expect(cached.source).toBe("cache");
    expect(loads).toBe(1);

    now += 299_999;
    await cache.get("mock", load);
    expect(loads).toBe(1);
    await cache.get("mock", load, true);
    expect(loads).toBe(2);

    now += 300_001;
    await cache.get("mock", load);
    expect(loads).toBe(3);
    cache.invalidate("mock");
    expect(cache.peek("mock")).toBeNull();
  });

  it("partitions entries by exact model tuple and invalidates all provider variants", async () => {
    const cache = new CapabilityCache({ now: () => 1_000 });
    let loads = 0;
    const load = async (): Promise<ProviderCapabilities> => {
      loads += 1;
      return fixtureCapabilities("2026-07-14T12:00:00.000Z");
    };
    await cache.get("mock", load, false, "model-a");
    await cache.get("mock", load, false, "model-b");
    await cache.get("mock", load, false, "model-a");
    expect(loads).toBe(2);
    expect(cache.peek("mock", "model-a")).not.toBeNull();
    expect(cache.peek("mock", "model-b")).not.toBeNull();
    cache.invalidate("mock");
    expect(cache.peek("mock", "model-a")).toBeNull();
    expect(cache.peek("mock", "model-b")).toBeNull();
    expect(() => cache.peek("mock", "")).toThrow(
      "INVALID_CAPABILITY_CONFIGURATION_KEY",
    );
  });

  it("selects only the requested adapter and never falls back", () => {
    const mock = new MockProvider();
    const registry = new ProviderRegistry([mock]);
    expect(registry.get("mock")).toBe(mock);
    expect(() => registry.get("gemini")).toThrow("PROVIDER_NOT_REGISTERED");
    expect(() => registry.get("external_manual")).toThrow(
      "INVALID_PROVIDER_ID",
    );
  });
});

function fixtureCapabilities(checkedAt: string): ProviderCapabilities {
  return {
    providerId: "mock",
    checkedAt,
    source: "fixture",
    auth: { state: "ok", detail: "جاهز" },
    text: {
      available: true,
      structured: true,
      modelId: "mock-v1",
    },
    image: {
      available: true,
      modelId: "mock-image-v1",
      maxReferenceImages: 20,
      reliableCharacterCount: 20,
      economyTier: false,
    },
    limits: { concurrencySuggested: 4 },
  };
}
