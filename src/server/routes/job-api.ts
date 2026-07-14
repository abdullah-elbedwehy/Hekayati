import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { entityIdSchema } from "../../domain/library/schemas.js";
import { JobError } from "../../jobs/errors.js";
import type { JobRuntime } from "../../jobs/runtime.js";
import { jobStateSchema, jobTargetSchema } from "../../jobs/schemas.js";
import type { ResumeCredentialsInput } from "../../jobs/types.js";

const jobParamsSchema = z.object({ jobId: entityIdSchema }).strict();
const incidentParamsSchema = z.object({ incidentId: entityIdSchema }).strict();
const projectParamsSchema = z.object({ projectId: entityIdSchema }).strict();
const expectedSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    expectedState: jobStateSchema,
  })
  .strict();
const prioritySchema = expectedSchema
  .extend({ priority: z.number().int().min(1).max(5) })
  .strict();
const actionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const quotaResumeSchema = z
  .object({
    actionId: actionIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    impactHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmedAffectedCount: z.number().int().nonnegative().max(500),
  })
  .strict();
const impactSchema = z
  .object({ impactHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const credentialResumeSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    impactHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const storageResumeSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    impactHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmedAffectedCount: z.number().int().nonnegative().max(500),
    confirmed: z.literal(true),
  })
  .strict();
const quotaScopeFields = {
  actionId: actionIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  impactHash: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: entityIdSchema.nullable(),
  standaloneScopeId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
    .nullable(),
} as const;
const quotaDecisionSchema = z
  .discriminatedUnion("decision", [
    z.object({ ...quotaScopeFields, decision: z.literal("wait") }).strict(),
    z
      .object({
        ...quotaScopeFields,
        decision: z.literal("continue"),
        alternateTarget: jobTargetSchema,
      })
      .strict(),
  ])
  .refine(validQuotaScope, { message: "QUOTA_SCOPE_REQUIRED" });

function validQuotaScope(value: {
  projectId: string | null;
  standaloneScopeId: string | null;
}): boolean {
  return (value.projectId === null) !== (value.standaloneScopeId === null);
}

export interface CredentialIncidentApi {
  resumeCredentials(
    incidentId: string,
    input: ResumeCredentialsInput,
  ): Promise<string[]>;
}

export function registerJobApi(
  app: FastifyInstance,
  jobs: JobRuntime,
  credentials?: CredentialIncidentApi,
): void {
  registerReadRoutes(app, jobs);
  registerJobActionRoutes(app, jobs);
  registerScopeRoutes(app, jobs);
  registerIncidentRoutes(app, jobs, credentials);
}

function registerReadRoutes(app: FastifyInstance, jobs: JobRuntime): void {
  app.get("/api/jobs", (_request, reply) => {
    noStore(reply);
    return jobs.queueProjection();
  });

  app.get("/api/jobs/:jobId", (request, reply) => {
    noStore(reply);
    const { jobId } = jobParamsSchema.parse(request.params);
    const projection = jobs
      .queueProjection()
      .jobs.find((candidate) => candidate.id === jobId);
    if (!projection) throw new JobError("JOB_NOT_FOUND", 404);
    return projection;
  });
}

function registerJobActionRoutes(app: FastifyInstance, jobs: JobRuntime): void {
  app.post("/api/jobs/:jobId/pause", (request, reply) => {
    noStore(reply);
    const { jobId } = jobParamsSchema.parse(request.params);
    jobs.scheduler.pause(jobId, expectedSchema.parse(request.body));
    return projectJob(jobs, jobId);
  });

  app.post("/api/jobs/:jobId/resume", (request, reply) => {
    noStore(reply);
    const { jobId } = jobParamsSchema.parse(request.params);
    jobs.scheduler.resume(jobId, expectedSchema.parse(request.body));
    return projectJob(jobs, jobId);
  });

  app.post("/api/jobs/:jobId/cancel", (request, reply) => {
    noStore(reply);
    const { jobId } = jobParamsSchema.parse(request.params);
    jobs.scheduler.cancel(jobId, expectedSchema.parse(request.body));
    return projectJob(jobs, jobId);
  });

  app.post("/api/jobs/:jobId/retry", (request, reply) => {
    noStore(reply);
    const { jobId } = jobParamsSchema.parse(request.params);
    jobs.scheduler.retry(jobId, expectedSchema.parse(request.body));
    return projectJob(jobs, jobId);
  });

  app.put("/api/jobs/:jobId/priority", (request, reply) => {
    noStore(reply);
    const { jobId } = jobParamsSchema.parse(request.params);
    jobs.scheduler.setPriority(jobId, prioritySchema.parse(request.body));
    return projectJob(jobs, jobId);
  });
}

function registerScopeRoutes(app: FastifyInstance, jobs: JobRuntime): void {
  app.post("/api/jobs/projects/:projectId/pause", (request, reply) => {
    noStore(reply);
    const { projectId } = projectParamsSchema.parse(request.params);
    const { impactHash } = impactSchema.parse(request.body);
    return {
      affectedJobIds: jobs.scheduler.pauseProject(projectId, impactHash),
    };
  });

  app.post("/api/jobs/projects/:projectId/resume", (request, reply) => {
    noStore(reply);
    const { projectId } = projectParamsSchema.parse(request.params);
    const { impactHash } = impactSchema.parse(request.body);
    return {
      affectedJobIds: jobs.scheduler.resumeProject(projectId, impactHash),
    };
  });
}

function registerIncidentRoutes(
  app: FastifyInstance,
  jobs: JobRuntime,
  credentials?: CredentialIncidentApi,
): void {
  app.post("/api/jobs/quota/:incidentId/decision", async (request, reply) => {
    noStore(reply);
    const { incidentId } = incidentParamsSchema.parse(request.params);
    const successorJobIds = await jobs.decideQuota(
      incidentId,
      quotaDecisionSchema.parse(request.body),
    );
    return { successorJobIds };
  });

  app.post("/api/jobs/quota/:incidentId/resume", async (request, reply) => {
    noStore(reply);
    const { incidentId } = incidentParamsSchema.parse(request.params);
    const affectedJobIds = await jobs.resumeQuota(
      incidentId,
      quotaResumeSchema.parse(request.body),
    );
    return { affectedJobIds };
  });

  if (credentials) {
    app.post(
      "/api/jobs/credentials/:incidentId/resume",
      async (request, reply) => {
        noStore(reply);
        const { incidentId } = incidentParamsSchema.parse(request.params);
        const affectedJobIds = await credentials.resumeCredentials(
          incidentId,
          credentialResumeSchema.parse(request.body),
        );
        return { affectedJobIds };
      },
    );
  }

  app.post("/api/jobs/storage/resume", async (request, reply) => {
    noStore(reply);
    return {
      affectedJobIds: await jobs.resumeStorage(
        storageResumeSchema.parse(request.body),
      ),
    };
  });
}

function projectJob(jobs: JobRuntime, jobId: string) {
  const projection = jobs
    .queueProjection()
    .jobs.find((candidate) => candidate.id === jobId);
  if (!projection) throw new JobError("JOB_NOT_FOUND", 404);
  return projection;
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}
