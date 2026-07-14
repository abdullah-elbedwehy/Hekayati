import { describe, expect, it, vi } from "vitest";

import { CapabilityCache } from "../../src/providers/capability-cache.js";
import type {
  AiProvider,
  ProviderCapabilities,
} from "../../src/providers/contract.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import {
  CredentialAvailabilityBroker,
  ExactCapabilityBroker,
  QuotaAvailabilityBroker,
  type ExactCapabilityPort,
} from "../../src/jobs/capabilities.js";
import { JobError } from "../../src/jobs/errors.js";
import type { JobTarget } from "../../src/jobs/schemas.js";

const hash = "6".repeat(64);
const now = "2026-07-14T00:00:00.000Z";

describe("exact job capability brokers", () => {
  it.each([
    { batchId: "", referenceCount: 0, participantCount: 0 },
    { batchId: "batch", referenceCount: -1, participantCount: 0 },
    { batchId: "batch", referenceCount: 0.5, participantCount: 0 },
    { batchId: "batch", referenceCount: 0, participantCount: -1 },
    { batchId: "batch", referenceCount: 0, participantCount: 0.5 },
  ])("rejects invalid bounded capability input %#", async (invalid) => {
    await expect(
      broker(capabilities()).acquireExact({
        ...invalid,
        target: target("image", "mock-image-v1"),
      }),
    ).rejects.toMatchObject({ code: "JOB_CAPABILITY_INPUT_INVALID" });
  });

  it("issues exact tickets for text, structured, and bounded images", async () => {
    const exact = broker(capabilities());
    await expect(
      exact.acquireExact(request(target("text", "mock-text-v1"))),
    ).resolves.toMatchObject({
      batchId: "batch",
      providerId: "mock",
      operation: "text",
      expiresAtMono: 300_010,
    });
    await expect(
      exact.acquireExact(request(target("structured", "mock-text-v1"))),
    ).resolves.toMatchObject({ operation: "structured" });
    await expect(
      exact.acquireExact({
        ...request(target("image", "mock-image-v1")),
        referenceCount: 2,
        participantCount: 2,
      }),
    ).resolves.toMatchObject({ operation: "image" });
  });

  it.each([
    [
      "text unavailable",
      { text: { available: false, structured: true } },
      target("text", "mock-text-v1"),
      "JOB_PROVIDER_MODEL_UNAVAILABLE",
    ],
    [
      "text model mismatch",
      { text: { available: true, structured: true, modelId: "other" } },
      target("text", "mock-text-v1"),
      "JOB_PROVIDER_MODEL_UNAVAILABLE",
    ],
    [
      "structured unavailable",
      { text: { available: true, structured: false, modelId: "mock-text-v1" } },
      target("structured", "mock-text-v1"),
      "JOB_PROVIDER_OPERATION_UNAVAILABLE",
    ],
    [
      "image unavailable",
      { image: imageCapability({ available: false }) },
      target("image", "mock-image-v1"),
      "JOB_PROVIDER_MODEL_UNAVAILABLE",
    ],
    [
      "image model mismatch",
      { image: imageCapability({ modelId: "other" }) },
      target("image", "mock-image-v1"),
      "JOB_PROVIDER_MODEL_UNAVAILABLE",
    ],
    [
      "unknown reference capacity",
      { image: imageCapability({ maxReferenceImages: null }) },
      target("image", "mock-image-v1"),
      "JOB_REFERENCE_LIMIT_UNAVAILABLE",
    ],
    [
      "reference capacity exceeded",
      { image: imageCapability({ maxReferenceImages: 1 }) },
      target("image", "mock-image-v1"),
      "JOB_REFERENCE_LIMIT_UNAVAILABLE",
    ],
    [
      "unknown character capacity",
      { image: imageCapability({ reliableCharacterCount: null }) },
      target("image", "mock-image-v1"),
      "JOB_CHARACTER_LIMIT_UNAVAILABLE",
    ],
    [
      "character capacity exceeded",
      { image: imageCapability({ reliableCharacterCount: 1 }) },
      target("image", "mock-image-v1"),
      "JOB_CHARACTER_LIMIT_UNAVAILABLE",
    ],
  ] as const)(
    "rejects %s without fallback",
    async (_name, override, exactTarget, code) => {
      const input = request(exactTarget);
      await expect(
        broker(capabilities(override)).acquireExact({
          ...input,
          referenceCount: exactTarget.operation === "image" ? 2 : 0,
          participantCount: exactTarget.operation === "image" ? 2 : 0,
        }),
      ).rejects.toMatchObject({ code });
    },
  );

  it("rejects a capability result for a different provider", async () => {
    const provider = {
      providerId: "mock",
      getCapabilities: vi.fn(),
    } as unknown as AiProvider;
    const cache = {
      get: vi.fn().mockResolvedValue(capabilities({ providerId: "gemini" })),
    } as unknown as CapabilityCache;
    const exact = new ExactCapabilityBroker(
      new ProviderRegistry([provider]),
      cache,
      () => 10,
    );
    await expect(
      exact.acquireExact(request(target("text", "mock-text-v1"))),
    ).rejects.toMatchObject({ code: "JOB_CAPABILITY_TARGET_MISMATCH" });
  });

  it.each([
    "JOB_PROVIDER_MODEL_UNAVAILABLE",
    "JOB_PROVIDER_OPERATION_UNAVAILABLE",
    "JOB_REFERENCE_LIMIT_UNAVAILABLE",
    "JOB_CHARACTER_LIMIT_UNAVAILABLE",
  ])("turns known quota unavailability %s into false", async (code) => {
    const exact = rejectingExact(new JobError(code));
    await expect(
      new QuotaAvailabilityBroker(exact).forceCheckExact(
        target("image", "mock-image-v1"),
      ),
    ).resolves.toBe(false);
  });

  it("returns true on exact availability and rethrows unexpected failures", async () => {
    const available = {
      acquireExact: vi.fn().mockResolvedValue(ticket()),
    } satisfies ExactCapabilityPort;
    await expect(
      new QuotaAvailabilityBroker(available).forceCheckExact(
        target("image", "mock-image-v1"),
      ),
    ).resolves.toBe(true);
    await expect(
      new CredentialAvailabilityBroker(available).forceCheckExact(
        target("image", "mock-image-v1"),
      ),
    ).resolves.toBe(true);

    const unexpected = rejectingExact(new Error("FIXTURE_UNEXPECTED"));
    await expect(
      new QuotaAvailabilityBroker(unexpected).forceCheckExact(
        target("image", "mock-image-v1"),
      ),
    ).rejects.toThrow("FIXTURE_UNEXPECTED");
    await expect(
      new CredentialAvailabilityBroker(unexpected).forceCheckExact(
        target("image", "mock-image-v1"),
      ),
    ).rejects.toThrow("FIXTURE_UNEXPECTED");
  });

  it("turns known credential unavailability into false", async () => {
    await expect(
      new CredentialAvailabilityBroker(
        rejectingExact(new JobError("JOB_PROVIDER_MODEL_UNAVAILABLE")),
      ).forceCheckExact(target("image", "mock-image-v1")),
    ).resolves.toBe(false);
  });
});

function broker(value: ProviderCapabilities): ExactCapabilityBroker {
  const provider = {
    providerId: "mock",
    getCapabilities: vi.fn().mockResolvedValue(value),
  } as unknown as AiProvider;
  return new ExactCapabilityBroker(
    new ProviderRegistry([provider]),
    new CapabilityCache({ now: () => 10 }),
    () => 10,
  );
}

function capabilities(
  override: Partial<ProviderCapabilities> = {},
): ProviderCapabilities {
  return {
    providerId: "mock",
    checkedAt: now,
    source: "fixture",
    auth: { state: "ok", detail: "fixture" },
    text: { available: true, structured: true, modelId: "mock-text-v1" },
    image: imageCapability(),
    limits: { concurrencySuggested: 2 },
    ...override,
  };
}

function imageCapability(
  override: Partial<ProviderCapabilities["image"]> = {},
): ProviderCapabilities["image"] {
  return {
    available: true,
    modelId: "mock-image-v1",
    maxReferenceImages: 2,
    reliableCharacterCount: 2,
    economyTier: true,
    ...override,
  };
}

function target(operation: JobTarget["operation"], modelId: string): JobTarget {
  return {
    providerId: "mock",
    modelId,
    operation,
    settingsHash: hash,
  };
}

function request(exactTarget: JobTarget) {
  return {
    batchId: "batch",
    target: exactTarget,
    referenceCount: 0,
    participantCount: 0,
  };
}

function rejectingExact(error: Error): ExactCapabilityPort {
  return { acquireExact: vi.fn().mockRejectedValue(error) };
}

function ticket() {
  return {
    ...target("image", "mock-image-v1"),
    batchId: "batch",
    checkedAt: now,
    expiresAtMono: 300_010,
  };
}
