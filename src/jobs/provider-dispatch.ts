import {
  resolvedImageRequestSchema,
  structuredRequestSchema,
  textRequestSchema,
  type CallControl,
} from "../providers/contract.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { JobError } from "./errors.js";
import type { PreparedDispatch } from "./pre-dispatch.js";
import type { JobRecord } from "./schemas.js";
import type { JobExecutionResult, RegisteredJobDefinition } from "./types.js";
import type {
  CurrentInputGuard,
  PreDispatchCoordinator,
} from "./pre-dispatch.js";

export class ProviderDispatchGateway {
  constructor(private readonly registry: ProviderRegistry) {}

  async execute(
    job: Readonly<JobRecord>,
    prepared: PreparedDispatch,
    control: CallControl,
  ): Promise<JobExecutionResult> {
    if (!job.target) throw new JobError("JOB_TARGET_REQUIRED");
    if (prepared.operation !== job.target.operation)
      throw new JobError("JOB_REQUEST_TARGET_MISMATCH");
    const provider = this.registry.get(job.target.providerId);
    const result = await dispatch(provider, prepared, control);
    if (!result.ok) return result;
    if (
      result.provenance.provider !== job.target.providerId ||
      result.provenance.modelId !== job.target.modelId
    )
      throw new JobError("JOB_PROVENANCE_TARGET_MISMATCH");
    return {
      ok: true,
      value: result.value,
      provenance: result.provenance,
    };
  }
}

export function createProviderJobDefinition(input: {
  jobType: string;
  requestSchema: RegisteredJobDefinition["requestSchema"];
  validateEnqueue: RegisteredJobDefinition["validateEnqueue"];
  guard: CurrentInputGuard;
  preDispatch: PreDispatchCoordinator;
  gateway: ProviderDispatchGateway;
  commit: RegisteredJobDefinition["commit"];
  discard?: RegisteredJobDefinition["discard"];
  normalizeError?: RegisteredJobDefinition["normalizeError"];
}): RegisteredJobDefinition {
  return {
    jobType: input.jobType,
    requestSchema: input.requestSchema,
    validateEnqueue: input.validateEnqueue,
    prepare: (job, batchId) =>
      input.preDispatch.prepare(job, input.guard, batchId),
    execute: ({ job, prepared, signal, timeoutMs }) =>
      input.gateway.execute(job, prepared as PreparedDispatch, {
        signal,
        timeoutMs,
      }),
    commit: input.commit,
    discard: input.discard,
    normalizeError: input.normalizeError,
  };
}

async function dispatch(
  provider: ReturnType<ProviderRegistry["get"]>,
  prepared: PreparedDispatch,
  control: CallControl,
) {
  if (prepared.operation === "text")
    return provider.generateText(
      textRequestSchema.parse(prepared.request),
      control,
    );
  if (prepared.operation === "structured")
    return provider.generateStructured(
      structuredRequestSchema.parse(prepared.request),
      control,
    );
  return provider.generateImage(
    resolvedImageRequestSchema.parse(prepared.request),
    control,
  );
}
