import { randomUUID } from "node:crypto";

import type { CapabilityCache } from "../providers/capability-cache.js";
import type { ProviderCapabilities } from "../providers/contract.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { JobError } from "./errors.js";
import type { JobTarget } from "./schemas.js";
import type {
  CredentialAvailabilityPort,
  QuotaAvailabilityPort,
} from "./types.js";

export interface ExactCapabilityTicket extends JobTarget {
  batchId: string;
  checkedAt: string;
  expiresAtMono: number;
}

export interface ExactCapabilityInput {
  batchId: string;
  target: JobTarget;
  referenceCount: number;
  participantCount: number;
}

export interface ExactCapabilityPort {
  acquireExact(input: ExactCapabilityInput): Promise<ExactCapabilityTicket>;
}

export class ExactCapabilityBroker implements ExactCapabilityPort {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly cache: CapabilityCache,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  async acquireExact(
    input: ExactCapabilityInput,
  ): Promise<ExactCapabilityTicket> {
    validateInput(input);
    const provider = this.registry.get(input.target.providerId);
    const capabilities = await this.cache.get(
      input.target.providerId,
      () => provider.getCapabilities(true),
      false,
      configurationKey(input),
    );
    assertAvailable(capabilities, input);
    return {
      ...input.target,
      batchId: input.batchId,
      checkedAt: capabilities.checkedAt,
      expiresAtMono: this.monotonicNow() + 300_000,
    };
  }
}

export class QuotaAvailabilityBroker implements QuotaAvailabilityPort {
  constructor(private readonly exact: ExactCapabilityPort) {}

  async forceCheckExact(target: JobTarget): Promise<boolean> {
    try {
      await this.exact.acquireExact({
        batchId: `quota-${randomUUID()}`,
        target,
        referenceCount: 0,
        participantCount: 0,
      });
      return true;
    } catch (error) {
      if (isUnavailable(error)) return false;
      throw error;
    }
  }
}

export class CredentialAvailabilityBroker implements CredentialAvailabilityPort {
  constructor(private readonly exact: ExactCapabilityPort) {}

  async forceCheckExact(target: JobTarget): Promise<boolean> {
    try {
      await this.exact.acquireExact({
        batchId: `credentials-${randomUUID()}`,
        target,
        referenceCount: 0,
        participantCount: 0,
      });
      return true;
    } catch (error) {
      if (isUnavailable(error)) return false;
      throw error;
    }
  }
}

function validateInput(input: ExactCapabilityInput): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.batchId) ||
    !Number.isInteger(input.referenceCount) ||
    input.referenceCount < 0 ||
    !Number.isInteger(input.participantCount) ||
    input.participantCount < 0
  )
    throw new JobError("JOB_CAPABILITY_INPUT_INVALID", 400);
}

function assertAvailable(
  capabilities: ProviderCapabilities,
  input: ExactCapabilityInput,
): void {
  const { target } = input;
  if (capabilities.providerId !== target.providerId)
    throw new JobError("JOB_CAPABILITY_TARGET_MISMATCH");
  if (target.operation === "image") {
    assertImageAvailable(capabilities, input);
    return;
  }
  if (
    !capabilities.text.available ||
    capabilities.text.modelId !== target.modelId
  )
    throw new JobError("JOB_PROVIDER_MODEL_UNAVAILABLE");
  if (target.operation === "structured" && !capabilities.text.structured)
    throw new JobError("JOB_PROVIDER_OPERATION_UNAVAILABLE");
}

function assertImageAvailable(
  capabilities: ProviderCapabilities,
  input: ExactCapabilityInput,
): void {
  const image = capabilities.image;
  if (!image.available || image.modelId !== input.target.modelId)
    throw new JobError("JOB_PROVIDER_MODEL_UNAVAILABLE");
  if (
    image.maxReferenceImages === null ||
    input.referenceCount > image.maxReferenceImages
  )
    throw new JobError("JOB_REFERENCE_LIMIT_UNAVAILABLE");
  if (
    image.reliableCharacterCount === null ||
    input.participantCount > image.reliableCharacterCount
  )
    throw new JobError("JOB_CHARACTER_LIMIT_UNAVAILABLE");
}

function configurationKey(input: ExactCapabilityInput): string {
  const target = input.target;
  return [
    input.batchId,
    target.providerId,
    target.modelId,
    target.operation,
    target.settingsHash,
  ].join(":");
}

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof JobError &&
    [
      "JOB_PROVIDER_MODEL_UNAVAILABLE",
      "JOB_PROVIDER_OPERATION_UNAVAILABLE",
      "JOB_REFERENCE_LIMIT_UNAVAILABLE",
      "JOB_CHARACTER_LIMIT_UNAVAILABLE",
    ].includes(error.code)
  );
}
