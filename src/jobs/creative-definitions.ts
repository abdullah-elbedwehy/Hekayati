import sharp from "sharp";
import { ZodError } from "zod";

import type { AssetStore } from "../assets/asset-store.js";
import { type AssetInput, type PreparedAsset } from "../assets/asset-store.js";
import { CreativeError } from "../domain/creative/errors.js";
import type { CreativePipelineService } from "../domain/creative/pipeline.js";
import type { CreativeSheetService } from "../domain/creative/sheets.js";
import type { SheetViewName } from "../domain/creative/schemas.js";
import { renderCharacterSheetPdf } from "../pdf/character-sheet.js";
import {
  imageResultSchema,
  type ImageResult,
  type Provenance,
} from "../providers/contract.js";
import { makeFailure, type NormalizedFailure } from "../providers/failures.js";
import type { PreparedDispatch } from "./pre-dispatch.js";
import type { PreDispatchCoordinator } from "./pre-dispatch.js";
import {
  createProviderJobDefinition,
  type ProviderDispatchGateway,
} from "./provider-dispatch.js";
import type { JobScheduler } from "./scheduler.js";
import {
  imageJobRequestSchema,
  localJobRequestSchema,
  structuredJobRequestSchema,
  type JobRecord,
} from "./schemas.js";
import type { JobExecutionResult, RegisteredJobDefinition } from "./types.js";
import { JobError } from "./errors.js";

const structuredJobTypes = [
  "story_plan",
  "story_text",
  "scene_list",
  "page_prompt",
  "review_findings",
] as const;

const sheetViews = [
  "face",
  "front",
  "threeQuarter",
  "fullBody",
  "mainOutfit",
] as const satisfies readonly SheetViewName[];

interface PreparedGeneratedImage {
  asset: PreparedAsset;
  image: ImageResult;
}

interface FinalizeInput {
  intentId: string;
  expectedRevision: number;
  views: Record<SheetViewName, string>;
  provenanceByView: Partial<Record<SheetViewName, Provenance>>;
}

interface PreparedSheetFinalization extends FinalizeInput {
  pdf: PreparedAsset;
}

export interface CreativeJobDefinitionsInput {
  pipeline: CreativePipelineService;
  sheets: CreativeSheetService;
  assets: AssetStore;
  preDispatch: PreDispatchCoordinator;
  gateway: ProviderDispatchGateway;
  scheduler: () => JobScheduler;
}

export function createCreativeJobDefinitions(
  input: CreativeJobDefinitionsInput,
): RegisteredJobDefinition[] {
  return [
    ...structuredJobTypes.map((jobType) =>
      structuredDefinition(jobType, input),
    ),
    imageDefinition("page_illustration", "illustration", input),
    imageDefinition("character_sheet_view", "sheet_view", input),
    sheetFinalizerDefinition(input),
  ];
}

function structuredDefinition(
  jobType: (typeof structuredJobTypes)[number],
  input: CreativeJobDefinitionsInput,
): RegisteredJobDefinition {
  return createProviderJobDefinition({
    jobType,
    requestSchema: structuredJobRequestSchema,
    validateEnqueue: validateProviderEnqueue("structured"),
    guard: { assertCurrent: (job) => input.pipeline.assertJobCurrent(job) },
    preDispatch: input.preDispatch,
    gateway: input.gateway,
    commit: ({ job, value, provenance }) =>
      input.pipeline.commitStructured(
        job,
        value,
        requireProvenance(provenance),
      ),
    normalizeError: normalizeCreativeJobError,
  });
}

function imageDefinition(
  jobType: "page_illustration" | "character_sheet_view",
  role: "illustration" | "sheet_view",
  input: CreativeJobDefinitionsInput,
): RegisteredJobDefinition {
  const guard = imageJobGuard(jobType, input);
  return {
    jobType,
    requestSchema: imageJobRequestSchema,
    validateEnqueue: validateProviderEnqueue("image"),
    prepare: (job, batchId) => input.preDispatch.prepare(job, guard, batchId),
    execute: async ({ job, prepared, signal, timeoutMs }) => {
      const providerResult = await input.gateway.execute(
        job,
        prepared as PreparedDispatch,
        { signal, timeoutMs },
      );
      if (!providerResult.ok) return providerResult;
      const provenance = requireProvenance(providerResult.provenance ?? null);
      const image = imageResultSchema.parse(providerResult.value);
      const asset = await input.assets.prepare(
        await generatedAssetInput(job, image, provenance, role),
      );
      return {
        ok: true,
        value: { asset, image } satisfies PreparedGeneratedImage,
        provenance,
      };
    },
    commit: ({ job, value, provenance }) => {
      const prepared = value as PreparedGeneratedImage;
      const asset = input.assets.commitPrepared(prepared.asset);
      if (jobType === "page_illustration")
        return input.pipeline.commitIllustration(
          job,
          asset.id,
          requireProvenance(provenance),
        );
      return { resultRefs: [asset.id], provenance };
    },
    discard: (value) =>
      input.assets.discardPrepared((value as PreparedGeneratedImage).asset),
    normalizeError: normalizeCreativeJobError,
  };
}

function imageJobGuard(
  jobType: "page_illustration" | "character_sheet_view",
  input: CreativeJobDefinitionsInput,
) {
  return jobType === "page_illustration"
    ? {
        assertCurrent: (job: Readonly<JobRecord>) =>
          input.pipeline.assertJobCurrent(job),
      }
    : {
        assertCurrent: (job: Readonly<JobRecord>) =>
          input.sheets.assertJobCurrent(job),
      };
}

function sheetFinalizerDefinition(
  input: CreativeJobDefinitionsInput,
): RegisteredJobDefinition {
  return {
    jobType: "character_sheet_finalize",
    requestSchema: localJobRequestSchema,
    validateEnqueue: validateSheetFinalizer,
    prepare: (job) => Promise.resolve(prepareFinalizeInput(job, input)),
    execute: ({ prepared }) => executeSheetFinalizer(prepared, input),
    commit: ({ job, value }) => commitSheetFinalizer(job, value, input),
    discard: (value) =>
      input.assets.discardPrepared((value as PreparedSheetFinalization).pdf),
    normalizeError: normalizeCreativeJobError,
  };
}

function validateSheetFinalizer(job: Readonly<JobRecord>): void {
  if (job.target !== null || job.projectId === null)
    throw new CreativeError("CREATIVE_JOB_NOT_BOUND");
}

async function executeSheetFinalizer(
  prepared: unknown,
  input: CreativeJobDefinitionsInput,
): Promise<JobExecutionResult> {
  const value = prepared as FinalizeInput;
  const intent = input.sheets.getIntent(value.intentId);
  const viewImages = await Promise.all(
    sheetViews.map(
      async (view) =>
        [
          view,
          {
            bytes: await input.assets.read(value.views[view]),
            mime: imageMime(input.assets, value.views[view]),
            alt: view,
          },
        ] as const,
    ),
  );
  const referenceThumbnails = await Promise.all(
    intent.referenceThumbnailAssetIds.map(async (assetId, index) => ({
      bytes: await input.assets.read(assetId),
      mime: imageMime(input.assets, assetId),
      alt: `reference-${index + 1}`,
    })),
  );
  const bytes = await renderCharacterSheetPdf({
    characterName: intent.characterName,
    views: Object.fromEntries(viewImages) as Record<
      SheetViewName,
      (typeof viewImages)[number][1]
    >,
    referenceThumbnails,
  });
  const pdf = await input.assets.prepare({
    bytes,
    extension: "pdf",
    mime: "application/pdf",
    role: "pdf_preview",
    origin: "derived",
  });
  return {
    ok: true,
    value: { ...value, pdf } satisfies PreparedSheetFinalization,
  };
}

function commitSheetFinalizer(
  job: Readonly<JobRecord>,
  value: unknown,
  input: CreativeJobDefinitionsInput,
) {
  const prepared = value as PreparedSheetFinalization;
  const pdf = input.assets.commitPrepared(prepared.pdf);
  const ready = input.sheets.commitReadySheet({
    intentId: prepared.intentId,
    expectedRevision: prepared.expectedRevision,
    views: prepared.views,
    pdfAssetId: pdf.id,
    provenanceByView: prepared.provenanceByView,
  });
  const gate = input.scheduler().enqueue({
    jobType: "human_gate",
    projectId: ready.sheet.projectId,
    standaloneScopeId: null,
    dependsOn: [job.id],
    priority: job.priority,
    intentId: `${ready.sheet.id}-approval`,
    target: null,
    request: {
      kind: "human_gate",
      gateKind: "character_approval",
      targetId: ready.sheet.id,
      targetVersionId: ready.sheet.id,
    },
    inputSnapshot: { sheet: ready.sheet.id, intent: ready.intent.id },
  });
  const bound = input.sheets.bindApprovalGate({
    intentId: ready.intent.id,
    expectedRevision: ready.intent.revision,
    gateJobId: gate.id,
  });
  return { resultRefs: [ready.sheet.id, pdf.id, gate.id, bound.id] };
}

function prepareFinalizeInput(
  job: Readonly<JobRecord>,
  input: CreativeJobDefinitionsInput,
): FinalizeInput {
  input.sheets.assertJobCurrent(job);
  const intent = input.sheets.getIntent(job.inputSnapshot.intent);
  const scheduler = input.scheduler();
  const entries = sheetViews.map((view) => {
    const jobId = intent.viewJobIds[view];
    const dependency = jobId ? scheduler.get(jobId) : null;
    const assetId = dependency?.resultRefs[0];
    if (
      !dependency ||
      dependency.state !== "succeeded" ||
      !assetId ||
      input.assets.get(assetId)?.role !== "sheet_view"
    )
      throw new CreativeError("CREATIVE_DEPENDENCY_INCOMPLETE");
    return [view, { assetId, provenance: dependency.provenance }] as const;
  });
  return {
    intentId: intent.id,
    expectedRevision: intent.revision,
    views: Object.fromEntries(
      entries.map(([view, value]) => [view, value.assetId]),
    ) as Record<SheetViewName, string>,
    provenanceByView: Object.fromEntries(
      entries.flatMap(([view, value]) =>
        value.provenance ? [[view, value.provenance]] : [],
      ),
    ),
  };
}

async function generatedAssetInput(
  job: Readonly<JobRecord>,
  result: ImageResult,
  provenance: Provenance,
  role: "illustration" | "sheet_view",
): Promise<AssetInput> {
  const processed = await sharp(Buffer.from(result.imageBytes), {
    failOn: "error",
  })
    .rotate()
    .png()
    .toBuffer({ resolveWithObject: true });
  if (!processed.info.width || !processed.info.height)
    throw new Error("IMAGE_DIMENSIONS_MISSING");
  const request = job.request.kind === "image" ? job.request.request : null;
  if (!request) throw new CreativeError("CREATIVE_JOB_NOT_BOUND");
  return {
    bytes: processed.data,
    extension: "png",
    mime: "image/png",
    role,
    origin: "generated",
    width: processed.info.width,
    height: processed.info.height,
    provenance: {
      provider: provenance.provider,
      model: provenance.modelId,
      at: provenance.at,
      jobId: job.id,
      inputVersionRefs: versionRefs({
        ...provenance.inputVersionRefs,
        ...job.inputSnapshot,
      }),
      promptVersion: provenance.promptVersion,
      referencedAssetIds: provenance.referenceAssetIds,
      attempt: provenance.attempt,
      settingsSnapshot: {
        schemaVersion: 1,
        settingsHash: job.target!.settingsHash,
        styleId: request.styleId,
        referenceBudget: request.referenceImages.length,
        output: request.output,
      },
    },
  };
}

function versionRefs(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) =>
        /^[a-z][A-Za-z0-9]{0,39}$/.test(key) &&
        /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value),
    ),
  );
}

function imageMime(
  assets: AssetStore,
  assetId: string,
): "image/png" | "image/jpeg" {
  const mime = assets.get(assetId)?.mime;
  if (mime !== "image/png" && mime !== "image/jpeg")
    throw new CreativeError("CREATIVE_DEPENDENCY_INCOMPLETE");
  return mime;
}

function requireProvenance(value: Provenance | null): Provenance {
  if (!value) throw new CreativeError("CREATIVE_DEPENDENCY_INCOMPLETE");
  return value;
}

function validateProviderEnqueue(operation: "structured" | "image") {
  return (job: {
    projectId: string | null;
    target: { operation: string } | null;
    request: { kind: string };
  }) => {
    if (
      job.projectId === null ||
      job.target?.operation !== operation ||
      job.request.kind !== operation
    )
      throw new CreativeError("CREATIVE_JOB_NOT_BOUND");
  };
}

function normalizeCreativeJobError(error: unknown): NormalizedFailure {
  if (error instanceof ZodError) return makeFailure("output_validation_failed");
  if (error instanceof JobError) {
    if (
      [
        "JOB_PROVIDER_MODEL_UNAVAILABLE",
        "JOB_PROVIDER_OPERATION_UNAVAILABLE",
        "JOB_REFERENCE_LIMIT_UNAVAILABLE",
        "JOB_CHARACTER_LIMIT_UNAVAILABLE",
      ].includes(error.code)
    ) {
      return makeFailure("provider_unavailable", { reasonCode: error.code });
    }
    if (
      ["JOB_CAPACITY_PLAN_MISMATCH", "JOB_CAPABILITY_INPUT_INVALID"].includes(
        error.code,
      )
    ) {
      return makeFailure("invalid_input", { reasonCode: error.code });
    }
  }
  if (error instanceof CreativeError) {
    if (
      error.code.includes("DEPENDENCY") ||
      error.code.includes("SHEET_NOT_APPROVED")
    )
      return makeFailure("missing_reference_asset", {
        reasonCode: error.code,
      });
    return makeFailure("stale_dependency", { reasonCode: error.code });
  }
  if (
    error instanceof Error &&
    (error.message.includes("Input buffer") ||
      error.message.includes("IMAGE_DIMENSIONS"))
  )
    return makeFailure("media_decode_failure");
  return makeFailure("unknown");
}
