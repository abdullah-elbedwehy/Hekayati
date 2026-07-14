import { createRequestHash } from "./idempotency.js";
import { jobTargetSchema, type JobTarget } from "./schemas.js";

export function createJobTarget(input: {
  providerId: JobTarget["providerId"];
  modelId: string;
  operation: JobTarget["operation"];
  configuration: unknown;
}): JobTarget {
  return jobTargetSchema.parse({
    providerId: input.providerId,
    modelId: input.modelId,
    operation: input.operation,
    settingsHash: createRequestHash({
      providerId: input.providerId,
      modelId: input.modelId,
      operation: input.operation,
      configuration: input.configuration,
    }),
  });
}

export function sameJobTarget(left: JobTarget, right: JobTarget): boolean {
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.operation === right.operation &&
    left.settingsHash === right.settingsHash
  );
}
