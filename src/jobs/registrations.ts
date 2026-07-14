import { humanGateJobRequestSchema, localJobRequestSchema } from "./schemas.js";
import type { JobRegistration } from "./types.js";

export function localJobRegistration(jobType: string): JobRegistration {
  return {
    jobType,
    requestSchema: localJobRequestSchema,
    validateEnqueue: () => undefined,
  };
}

export function humanGateJobRegistration(jobType: string): JobRegistration {
  return {
    jobType,
    requestSchema: humanGateJobRequestSchema,
    validateEnqueue: () => undefined,
  };
}
