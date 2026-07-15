import sharp from "sharp";

import type { AssetStore, PreparedAsset } from "../assets/asset-store.js";
import { LayoutError } from "../domain/layout/errors.js";
import {
  PreviewAssemblyService,
  type PreparedPreviewAssembly,
} from "../domain/layout/preview-assembly.js";
import {
  LayoutService,
  type DeriveSpecialLayoutInput,
} from "../domain/layout/layouts.js";
import {
  A4_COMPOSITION_PROFILE,
  type RegionMeasurement,
} from "../domain/layout/policy.js";
import type {
  LayoutJobSource,
  PreviewWorkflowCoordinator,
} from "../domain/layout/workflow.js";
import { analyzeImageRegions } from "../layout/image-analysis.js";
import { PreviewPdfValidationError } from "../pdf/preview-validator.js";
import { makeFailure, type NormalizedFailure } from "../providers/failures.js";
import { JobError } from "./errors.js";
import type { JobScheduler } from "./scheduler.js";
import { localJobRequestSchema, type JobRecord } from "./schemas.js";
import type {
  EnqueueJobInput,
  JobExecutionResult,
  RegisteredJobDefinition,
} from "./types.js";

type PlacementMeasurements = Record<
  "top" | "bottom" | "right" | "left",
  RegionMeasurement
>;

interface PreparedPageLayout {
  source: LayoutJobSource;
  sourceBytes: Buffer | null;
  identity: PreparedAsset | null;
}

interface ExecutedPageLayout extends PreparedPageLayout {
  measurements: PlacementMeasurements;
}

export interface PageLayoutJobDefinitionInput {
  assets: AssetStore;
  workflow: PreviewWorkflowCoordinator;
}

export interface LayoutJobDefinitionsInput extends PageLayoutJobDefinitionInput {
  scheduler: () => JobScheduler;
}

export function createLayoutJobDefinitions(
  input: LayoutJobDefinitionsInput,
): RegisteredJobDefinition[] {
  return [
    createPageLayoutJobDefinition(input),
    createPreviewJobDefinition(input),
  ];
}

export function createPageLayoutJobDefinition(
  input: PageLayoutJobDefinitionInput,
): RegisteredJobDefinition {
  return {
    jobType: "page_layout",
    requestSchema: localJobRequestSchema,
    validateEnqueue: validateLocalLayoutJob,
    prepare: (job) => preparePageLayout(job, input),
    execute: ({ prepared, signal }) => executePageLayout(prepared, signal),
    commit: ({ job, value }) => commitPageLayout(job, value, input),
    discard: (value) => discardPageLayout(value, input.assets),
    normalizeError: normalizeLayoutJobError,
  };
}

function createPreviewJobDefinition(
  input: LayoutJobDefinitionsInput,
): RegisteredJobDefinition {
  const service = () =>
    new PreviewAssemblyService(
      input.workflow.workflowStore(),
      input.assets,
      input.workflow,
      input.scheduler(),
    );
  return {
    jobType: "preview_pdf",
    requestSchema: localJobRequestSchema,
    validateEnqueue: validateLocalPreviewJob,
    prepare: (job) => service().prepare(job),
    execute: ({ prepared, signal }) =>
      Promise.resolve(
        signal.aborted
          ? { ok: false as const, failure: makeFailure("timeout") }
          : { ok: true as const, value: prepared },
      ),
    commit: ({ job, value }) =>
      service().commit(job, value as PreparedPreviewAssembly),
    discard: (value) => service().discard(value as PreparedPreviewAssembly),
    normalizeError: normalizeLayoutJobError,
  };
}

function validateLocalLayoutJob(job: Readonly<EnqueueJobInput>): void {
  if (
    job.target !== null ||
    !job.projectId ||
    job.request.kind !== "local" ||
    !job.inputSnapshot.pageId ||
    !job.inputSnapshot.pageRevision ||
    !job.inputSnapshot.workflowHash ||
    !job.inputSnapshot.typographySettingsHash ||
    !job.inputSnapshot.fontManifestHash
  )
    throw new JobError("JOB_REQUEST_SCHEMA_INVALID", 400);
}

function validateLocalPreviewJob(job: Readonly<EnqueueJobInput>): void {
  if (
    job.target !== null ||
    !job.projectId ||
    job.request.kind !== "local" ||
    !job.inputSnapshot.projectRevision ||
    !job.inputSnapshot.workflowRevision ||
    !job.inputSnapshot.workflowHash ||
    !job.inputSnapshot.coverVersionId ||
    !job.inputSnapshot.watermarkSettingsHash
  )
    throw new JobError("JOB_REQUEST_SCHEMA_INVALID", 400);
}

async function preparePageLayout(
  job: Readonly<JobRecord>,
  input: PageLayoutJobDefinitionInput,
): Promise<PreparedPageLayout> {
  const source = input.workflow.layoutJobSource(job);
  if (
    source.page.kind === "ending2" &&
    source.selectionSource === "automatic_v1"
  ) {
    const bytes = await bundledIdentityPng();
    const identity = await input.assets.prepare({
      bytes,
      extension: "png",
      mime: "image/png",
      role: "illustration",
      origin: "derived",
      width: 1_400,
      height: 1_900,
    });
    return { source, sourceBytes: bytes, identity };
  }
  const sourceBytes = source.sourceAssetId
    ? await input.assets.read(source.sourceAssetId)
    : null;
  return { source, sourceBytes, identity: null };
}

async function executePageLayout(
  prepared: unknown,
  signal: AbortSignal,
): Promise<JobExecutionResult> {
  if (signal.aborted) return { ok: false, failure: makeFailure("timeout") };
  const value = prepared as PreparedPageLayout;
  const measurements = value.sourceBytes
    ? await measuredRegions(value.sourceBytes)
    : emptyPageMeasurements();
  if (signal.aborted) return { ok: false, failure: makeFailure("timeout") };
  return { ok: true, value: { ...value, measurements } };
}

function commitPageLayout(
  job: Readonly<JobRecord>,
  value: unknown,
  input: PageLayoutJobDefinitionInput,
) {
  const executed = value as ExecutedPageLayout;
  const identity = executed.identity
    ? input.assets.commitPrepared(executed.identity)
    : null;
  const service = new LayoutService(
    input.workflow.workflowStore(),
    input.assets,
    {
      typographySettingsHash: executed.source.typographySettingsHash,
      fontManifestHash: executed.source.fontManifestHash,
    },
  );
  const result =
    executed.source.page.kind === "story"
      ? service.deriveStoryLayout({
          pageId: executed.source.page.id,
          expectedPageRevision: executed.source.page.revision,
          jobId: job.id,
          workRequestId: executed.source.workRequestId,
          requestedPlacement: executed.source.requestedPlacement,
          measurements: executed.measurements,
        })
      : service.deriveSpecialLayout(
          specialLayoutInput(job, executed, identity),
        );
  const workflow = input.workflow.advance(executed.source.projectId);
  return { resultRefs: [result.layout.id, result.head.id, workflow.id] };
}

function specialLayoutInput(
  job: Readonly<JobRecord>,
  executed: ExecutedPageLayout,
  identity: ReturnType<AssetStore["get"]>,
): DeriveSpecialLayoutInput {
  return {
    pageId: executed.source.page.id,
    expectedPageRevision: executed.source.page.revision,
    jobId: job.id,
    requestedPlacement: executed.source.requestedPlacement,
    measurements: executed.measurements,
    selectionSource: executed.source.selectionSource,
    selectedAsset: executed.source.selectedAsset,
    identityAsset: identity
      ? { assetId: identity.id, checksum: identity.sha256 }
      : null,
  };
}

async function discardPageLayout(
  value: unknown,
  assets: AssetStore,
): Promise<void> {
  const identity = (value as Partial<ExecutedPageLayout>)?.identity;
  if (identity) await assets.discardPrepared(identity);
}

async function measuredRegions(bytes: Buffer): Promise<PlacementMeasurements> {
  const analyzed = await analyzeImageRegions(
    bytes,
    A4_COMPOSITION_PROFILE.placementRegions,
  );
  return {
    top: analyzed.top,
    bottom: analyzed.bottom,
    right: analyzed.right,
    left: analyzed.left,
  };
}

function emptyPageMeasurements(): PlacementMeasurements {
  return {
    top: { quietness: 1, contrast: 21 },
    bottom: { quietness: 1, contrast: 21 },
    right: { quietness: 1, contrast: 21 },
    left: { quietness: 1, contrast: 21 },
  };
}

async function bundledIdentityPng(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1900" viewBox="0 0 1400 1900">
    <rect width="1400" height="1900" fill="#FFF8E8"/>
    <circle cx="700" cy="820" r="390" fill="#FFD43B"/>
    <path d="M700 420 C820 260 1030 260 1090 420 C930 400 820 470 700 590Z" fill="#2F9E6A"/>
    <path d="M420 1320 Q700 1120 980 1320 Q700 1520 420 1320Z" fill="#FF8A1F"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

function normalizeLayoutJobError(error: unknown): NormalizedFailure {
  if (error instanceof PreviewPdfValidationError)
    return makeFailure("output_validation_failed", {
      reasonCode: error.code,
    });
  if (error instanceof LayoutError) {
    if (error.code.includes("STALE") || error.code.includes("CONFLICT"))
      return makeFailure("stale_dependency", { reasonCode: error.code });
    if (
      error.code.includes("SOURCE") ||
      error.code.includes("REVIEW") ||
      error.code.includes("ASSET")
    )
      return makeFailure("missing_reference_asset", {
        reasonCode: error.code,
      });
    return makeFailure("malformed_output", { reasonCode: error.code });
  }
  return makeFailure("unknown");
}
