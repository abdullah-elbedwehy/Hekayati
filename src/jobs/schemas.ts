import { z } from "zod";

import { entityIdSchema, sha256Pattern } from "../domain/library/schemas.js";
import {
  imageRequestDraftSchema,
  provenanceSchema,
  providerIdSchema,
  structuredRequestSchema,
  textRequestSchema,
} from "../providers/contract.js";
import { normalizedFailureSchema } from "../providers/failures.js";

const safeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const hashSchema = z.string().regex(sha256Pattern);
const timestampSchema = z.iso.datetime();
const monotonicSchema = z.number().finite().nonnegative();
const boundedVersionMapSchema = z
  .record(safeIdSchema, safeIdSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 200)
      context.addIssue({ code: "custom", message: "TOO_MANY_INPUT_REFS" });
  });

export const jobStateSchema = z.enum([
  "created",
  "blocked",
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "paused",
  "canceled",
  "waiting_review",
]);

export const jobTargetSchema = z
  .object({
    providerId: providerIdSchema,
    modelId: safeIdSchema,
    operation: z.enum(["text", "structured", "image"]),
    settingsHash: hashSchema,
  })
  .strict();

export const localJobRequestSchema = z
  .object({ kind: z.literal("local"), payloadHash: hashSchema })
  .strict();
export const humanGateJobRequestSchema = z
  .object({
    kind: z.literal("human_gate"),
    gateKind: safeIdSchema,
    targetId: safeIdSchema,
    targetVersionId: safeIdSchema,
  })
  .strict();
export const textJobRequestSchema = z
  .object({ kind: z.literal("text"), request: textRequestSchema })
  .strict();
export const structuredJobRequestSchema = z
  .object({ kind: z.literal("structured"), request: structuredRequestSchema })
  .strict();
export const imageJobRequestSchema = z
  .object({ kind: z.literal("image"), request: imageRequestDraftSchema })
  .strict();

export const jobRequestSchema = z.discriminatedUnion("kind", [
  localJobRequestSchema,
  humanGateJobRequestSchema,
  textJobRequestSchema,
  structuredJobRequestSchema,
  imageJobRequestSchema,
]);

export const jobLeaseSchema = z
  .object({
    workerId: safeIdSchema,
    bootId: safeIdSchema,
    claimToken: safeIdSchema,
    claimedAtMono: monotonicSchema,
    expiresAtMono: monotonicSchema,
  })
  .strict()
  .refine((lease) => lease.expiresAtMono > lease.claimedAtMono, {
    message: "INVALID_LEASE_WINDOW",
  });

const retryScheduleSchema = z
  .object({
    scheduledAt: timestampSchema,
    nextEligibleAt: timestampSchema,
    bootId: safeIdSchema,
    nextEligibleAtMono: monotonicSchema,
    delayMs: z.number().int().nonnegative().max(86_400_000),
  })
  .strict();
const progressSchema = z
  .object({
    attempt: z.number().int().positive(),
    percent: z.number().int().min(0).max(100),
    noteCode: safeIdSchema,
    updatedAtMono: monotonicSchema,
    noProgress: z.boolean(),
  })
  .strict();

const structuralDiagnosticSchema = z
  .object({
    path: z.array(safeIdSchema).max(8),
    code: safeIdSchema,
  })
  .strict();

export const persistedJobFailureSchema = normalizedFailureSchema
  .omit({ providerDetail: true })
  .extend({
    diagnostics: z.array(structuralDiagnosticSchema).max(10).default([]),
  })
  .strict();

export const jobRecordSchema = z
  .object({
    id: entityIdSchema,
    schemaVersion: z.literal(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revision: z.number().int().nonnegative(),
    jobType: safeIdSchema,
    projectId: entityIdSchema.nullable(),
    standaloneScopeId: safeIdSchema.nullable(),
    dependsOn: z.array(entityIdSchema).max(500),
    priority: z.number().int().min(1).max(5),
    createdSequence: z.number().int().nonnegative().optional(),
    intentId: safeIdSchema,
    idempotencyKey: hashSchema,
    requestHash: hashSchema,
    target: jobTargetSchema.nullable(),
    request: jobRequestSchema,
    inputSnapshot: boundedVersionMapSchema,
    state: jobStateSchema,
    stateReason: safeIdSchema.nullable(),
    resumeState: jobStateSchema.nullable(),
    resumeReason: safeIdSchema.nullable().optional(),
    lease: jobLeaseSchema.nullable(),
    attempts: z.number().int().nonnegative(),
    autoRetryIndex: z.number().int().nonnegative(),
    manualRetryCount: z.number().int().nonnegative(),
    retrySchedule: retryScheduleSchema.nullable(),
    progress: progressSchema.nullable(),
    failure: persistedJobFailureSchema.nullable(),
    provenance: provenanceSchema.nullable(),
    resultRefs: z.array(safeIdSchema).max(500),
    supersedesJobId: entityIdSchema.nullable(),
    successorJobIds: z.array(entityIdSchema).max(500),
  })
  .strict()
  .superRefine((job, context) => {
    if ((job.projectId === null) === (job.standaloneScopeId === null)) {
      context.addIssue({ code: "custom", message: "JOB_SCOPE_REQUIRED" });
    }
    if (
      job.request.kind === "human_gate" &&
      !["blocked", "waiting_review", "succeeded", "canceled"].includes(
        job.state,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "HUMAN_GATE_STATE_REQUIRED",
      });
    }
    if (job.lease !== null && !["claimed", "running"].includes(job.state)) {
      context.addIssue({
        code: "custom",
        path: ["lease"],
        message: "LEASE_STATE_MISMATCH",
      });
    }
  });

export type JobRecord = z.infer<typeof jobRecordSchema>;
export type JobRequest = z.infer<typeof jobRequestSchema>;
export type JobState = z.infer<typeof jobStateSchema>;
export type JobTarget = z.infer<typeof jobTargetSchema>;

export const jobEventKindSchema = z.enum([
  "enqueued",
  "claimed",
  "running",
  "heartbeat",
  "progress",
  "retry_scheduled",
  "failed",
  "paused",
  "resumed",
  "canceled",
  "priority_changed",
  "succeeded",
  "commit_rejected",
  "recovered",
  "gate_completed",
  "successor_linked",
]);

export const jobEventSchema = z
  .object({
    id: entityIdSchema,
    schemaVersion: z.literal(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    jobId: entityIdSchema,
    sequence: z.number().int().positive(),
    kind: jobEventKindSchema,
    attempt: z.number().int().positive().nullable(),
    fromState: jobStateSchema.nullable(),
    toState: jobStateSchema.nullable(),
    reason: safeIdSchema.nullable(),
    noteCode: safeIdSchema.nullable(),
  })
  .strict();

export const quotaIncidentSchema = z
  .object({
    id: entityIdSchema,
    schemaVersion: z.literal(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revision: z.number().int().nonnegative(),
    providerId: providerIdSchema,
    operation: z.enum(["text", "structured", "image"]),
    status: z.enum(["open", "resolved"]),
    affectedScopeIds: z.array(safeIdSchema).max(500),
    ownedJobIds: z.array(entityIdSchema).max(500),
    originalTargets: z.array(jobTargetSchema).min(1).max(500),
  })
  .strict();

export const quotaDecisionAuditSchema = z
  .object({
    id: entityIdSchema,
    schemaVersion: z.literal(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    actionId: safeIdSchema,
    requestHash: hashSchema,
    incidentId: entityIdSchema,
    projectId: entityIdSchema.nullable(),
    standaloneScopeId: safeIdSchema.nullable(),
    decision: z.enum(["wait", "continue", "resume"]),
    impactHash: hashSchema,
    alternateTarget: jobTargetSchema.nullable(),
    affectedJobIds: z.array(entityIdSchema).max(500),
    successorJobIds: z.array(entityIdSchema).max(500),
  })
  .strict()
  .refine(
    (event) =>
      event.decision === "resume"
        ? event.projectId === null && event.standaloneScopeId === null
        : (event.projectId === null) !== (event.standaloneScopeId === null),
    { message: "AUDIT_SCOPE_REQUIRED" },
  );

export const credentialIncidentSchema = z
  .object({
    id: entityIdSchema,
    schemaVersion: z.literal(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revision: z.number().int().nonnegative(),
    providerId: providerIdSchema,
    status: z.enum(["open", "resolved"]),
    affectedScopeIds: z.array(safeIdSchema).max(500),
    ownedJobIds: z.array(entityIdSchema).max(500),
    originalTargets: z.array(jobTargetSchema).min(1).max(500),
  })
  .strict();

export const credentialRemediationAuditSchema = z
  .object({
    id: entityIdSchema,
    schemaVersion: z.literal(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    incidentId: entityIdSchema,
    impactHash: hashSchema,
    affectedJobIds: z.array(entityIdSchema).max(500),
    checkedTargetCount: z.number().int().positive().max(500),
  })
  .strict();

export const providerTargetChangeAuditSchema = z
  .object({
    id: entityIdSchema,
    schemaVersion: z.literal(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    expectedSettingsUpdatedAt: timestampSchema,
    settingsUpdatedAt: timestampSchema,
    impactHash: hashSchema,
    operations: z
      .array(z.enum(["text", "structured", "image"]))
      .min(1)
      .max(3),
    affectedJobIds: z.array(entityIdSchema).max(500),
    successorJobIds: z.array(entityIdSchema).max(500),
  })
  .strict();

export const storageControlSchema = z
  .object({
    id: z.literal("scheduler"),
    schemaVersion: z.literal(1),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revision: z.number().int().nonnegative(),
    active: z.boolean(),
    reason: z
      .enum(["disk_write_failure", "insufficient_disk_space"])
      .nullable(),
    incidentId: entityIdSchema.nullable().default(null),
    ownedJobIds: z.array(entityIdSchema).max(500).default([]),
    detectedAt: timestampSchema.nullable(),
    lastProbeAt: timestampSchema.nullable(),
    lastProbeStatus: z.enum(["failed", "succeeded"]).nullable(),
    workerStatus: z.enum(["stopped", "running", "halted"]),
    bootId: safeIdSchema.nullable(),
    lastRecoveryAt: timestampSchema.nullable(),
  })
  .strict();

export type JobEvent = z.infer<typeof jobEventSchema>;
export type JobEventKind = z.infer<typeof jobEventKindSchema>;
export type QuotaIncident = z.infer<typeof quotaIncidentSchema>;
export type QuotaDecisionAudit = z.infer<typeof quotaDecisionAuditSchema>;
export type CredentialIncident = z.infer<typeof credentialIncidentSchema>;
export type CredentialRemediationAudit = z.infer<
  typeof credentialRemediationAuditSchema
>;
export type ProviderTargetChangeAudit = z.infer<
  typeof providerTargetChangeAuditSchema
>;
export type StorageControl = z.infer<typeof storageControlSchema>;
