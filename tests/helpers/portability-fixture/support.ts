import { createHash } from "node:crypto";

import { z } from "zod";

import type { AssetStore } from "../../../src/assets/asset-store.js";
import { entityIdSchema } from "../../../src/domain/library/index.js";
import {
  DocumentRepository,
  type DocumentStore,
} from "../../../src/domain/repository/document-store.js";
import {
  humanGateJobRegistration,
  localJobRegistration,
} from "../../../src/jobs/registrations.js";
import { JobScheduler } from "../../../src/jobs/scheduler.js";
import type { JobFence, JobRecord } from "../../../src/jobs/types.js";
import type { Provenance } from "../../../src/providers/contract.js";

export const portabilityFixtureAt = "2026-07-16T00:00:00.000Z";

export interface PortabilityFixtureScope {
  customerId: string;
  familyId: string;
  projectId: string;
}

export const syntheticStudioFixtureSchema = z
  .object({
    id: entityIdSchema,
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    owner: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("customer"),
          customerId: entityIdSchema,
          familyId: entityIdSchema,
        })
        .strict(),
      z.object({ kind: z.literal("prompt_only") }).strict(),
    ]),
    projectId: entityIdSchema.nullable(),
    assetId: entityIdSchema,
    promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type SyntheticStudioFixture = z.infer<
  typeof syntheticStudioFixtureSchema
>;

export function fixtureScheduler(store: DocumentStore, nextId: () => string) {
  const localTypes = [
    "page_prompt",
    "story_plan",
    "character_sheet_view",
    "character_sheet_finalize",
    "page_layout",
    "preview_pdf",
    "print_interior",
    "print_cover",
    "print_preflight",
  ];
  const gateTypes = [
    "character_approval_gate",
    "customer_approval_gate",
    "print_converted_proof_gate",
  ];
  let claim = 0;
  return new JobScheduler(store, {
    registeredJobs: [
      ...localTypes.map(localJobRegistration),
      ...gateTypes.map(humanGateJobRegistration),
    ],
    nowIso: () => portabilityFixtureAt,
    idFactory: nextId,
    claimTokenFactory: () => `portability-claim-${claim++}`,
  });
}

export function succeedLocalJob(
  scheduler: JobScheduler,
  input: {
    id?: string;
    jobType: string;
    projectId: string;
    intentId: string;
    dependsOn?: string[];
    resultRefs: string[];
  },
): JobRecord {
  const queued = scheduler.enqueue({
    ...(input.id ? { id: input.id } : {}),
    jobType: input.jobType,
    projectId: input.projectId,
    standaloneScopeId: null,
    dependsOn: input.dependsOn ?? [],
    priority: 3,
    intentId: input.intentId,
    target: null,
    request: { kind: "local", payloadHash: hash(`job-${input.intentId}`) },
    inputSnapshot: { projectVersion: input.projectId },
  });
  const claimed = scheduler.claimNext({
    workerId: "portability-worker",
    bootId: "portability-boot",
    nowMonoMs: 10,
    nowWallMs: Date.parse(portabilityFixtureAt),
    leaseTtlMs: 30_000,
    concurrencyPerProvider: 4,
  });
  if (!claimed || claimed.id !== queued.id)
    throw new Error("PORTABILITY_JOB_CLAIM_ORDER_INVALID");
  const running = scheduler.markRunning(claimed.id, fence(claimed), 11);
  return scheduler.commitSuccess(
    running.id,
    fence(running),
    input.resultRefs,
    12,
  );
}

export function waitingGate(
  scheduler: JobScheduler,
  input: {
    jobType: string;
    gateKind: string;
    projectId: string;
    targetId: string;
    targetVersionId: string;
    intentId: string;
    dependsOn?: string[];
  },
): JobRecord {
  return scheduler.enqueue({
    jobType: input.jobType,
    projectId: input.projectId,
    standaloneScopeId: null,
    dependsOn: input.dependsOn ?? [],
    priority: 3,
    intentId: input.intentId,
    target: null,
    request: {
      kind: "human_gate",
      gateKind: input.gateKind,
      targetId: input.targetId,
      targetVersionId: input.targetVersionId,
    },
    inputSnapshot: {},
  });
}

export function seedSyntheticStudio(
  store: DocumentStore,
  scope: PortabilityFixtureScope,
  reusedAssetId: string,
  nextId: () => string,
) {
  const repository = new DocumentRepository(
    store,
    "synthetic_studio_entries",
    syntheticStudioFixtureSchema,
  );
  const common = {
    schemaVersion: 1 as const,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    assetId: reusedAssetId,
  };
  const owned = repository.put({
    ...common,
    id: nextId(),
    owner: {
      kind: "customer",
      customerId: scope.customerId,
      familyId: scope.familyId,
    },
    projectId: scope.projectId,
    promptHash: hash("studio-owned"),
  });
  const promptOnly = repository.put({
    ...common,
    id: nextId(),
    owner: { kind: "prompt_only" },
    projectId: null,
    promptHash: hash("studio-prompt-only"),
  });
  return { owned, promptOnly };
}

export function collectionIds(
  store: DocumentStore,
): Readonly<Record<string, readonly string[]>> {
  const rows = store.database
    .prepare("SELECT collection, id FROM documents ORDER BY collection, id")
    .all() as Array<{ collection: string; id: string }>;
  const grouped: Record<string, string[]> = {};
  for (const row of rows) (grouped[row.collection] ??= []).push(row.id);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(grouped).map(([collection, ids]) => [
        collection,
        Object.freeze([...ids]),
      ]),
    ),
  );
}

export function deterministicIdFactory(): () => string {
  let index = 1;
  return () => `01J${String(index++).padStart(23, "0")}`;
}

export function reusableAssetInput() {
  return {
    bytes: Buffer.from("synthetic-retained-reuse"),
    extension: "png",
    mime: "image/png",
    role: "thumbnail" as const,
    origin: "derived" as const,
  };
}

export function neutralProvenance(): Provenance {
  return {
    provider: "mock",
    modelId: "mock-portability-v1",
    at: portabilityFixtureAt,
    inputVersionRefs: {},
    promptVersion: "portability-fixture-v1",
    referenceAssetIds: [],
    attempt: 1,
    settingsSnapshotHash: hash("provenance-settings"),
  };
}

export function syntheticPdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% synthetic ${marker}\n%%EOF\n`);
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type StoredAsset = NonNullable<ReturnType<AssetStore["get"]>>;

function fence(job: JobRecord): JobFence {
  if (!job.lease) throw new Error("PORTABILITY_JOB_FENCE_MISSING");
  return {
    workerId: job.lease.workerId,
    bootId: job.lease.bootId,
    claimToken: job.lease.claimToken,
    attempt: job.attempts,
  };
}
