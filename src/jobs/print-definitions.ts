import type { AssetStore, PreparedAsset } from "../assets/asset-store.js";
import { ApprovalError } from "../domain/layout/approvals.js";
import { hashCanonical } from "../domain/layout/hashes.js";
import { PrintError } from "../domain/print/errors.js";
import type {
  MaterializationContext,
  PreparedPrintArtifactCommit,
  PrintProductionService,
} from "../domain/print/workflow.js";
import type { PrintRun } from "../domain/print/schemas.js";
import type {
  PrintCoverDocument,
  PrintInteriorDocument,
} from "../pdf/print-document.js";
import type { PrintDocumentCompiler } from "../pdf/print-document-compiler.js";
import {
  PRINT_FONT_POLICY_VERSION,
  PRINT_RENDERER_VERSION,
  renderPrintCover,
  renderPrintInterior,
  type PrintCoverRenderResult,
  type PrintRenderResult,
} from "../pdf/print-renderer.js";
import {
  CmykConversionError,
  convertPdfToCmyk,
  type CmykConversionResult,
} from "../print/cmyk.js";
import { JobError } from "./errors.js";
import { localJobRequestSchema, type JobRecord } from "./schemas.js";
import type {
  EnqueueJobInput,
  JobExecutionResult,
  RegisteredJobDefinition,
} from "./types.js";
import { makeFailure, type NormalizedFailure } from "../providers/failures.js";

export interface PrintCompilerPort {
  compileInterior(
    context: MaterializationContext,
  ): Promise<PrintInteriorDocument>;
  compileCover(context: MaterializationContext): Promise<PrintCoverDocument>;
}

export interface PrintRendererPort {
  interior(
    document: PrintInteriorDocument,
    options?: { signal?: AbortSignal },
  ): Promise<PrintRenderResult>;
  cover(
    document: PrintCoverDocument,
    options?: { signal?: AbortSignal },
  ): Promise<PrintCoverRenderResult>;
}

export interface CmykConverterPort {
  convert(input: {
    pdfBytes: Buffer;
    iccBytes: Buffer;
    expectedIccChecksum: string;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<CmykConversionResult>;
}

export interface PrintJobDefinitionsInput {
  production: () => PrintProductionService;
  compiler: () => PrintCompilerPort | PrintDocumentCompiler;
  assets: AssetStore;
  renderer?: PrintRendererPort;
  cmyk?: CmykConverterPort;
}

interface PreparedProducer {
  kind: "interior" | "cover";
  context: MaterializationContext & { run: PrintRun };
  document: PrintInteriorDocument | PrintCoverDocument;
}

interface ExecutedProducer {
  commit: PreparedPrintArtifactCommit;
}

export function createPrintProducerDefinitions(
  input: PrintJobDefinitionsInput,
): RegisteredJobDefinition[] {
  return [
    producerDefinition("interior", input),
    producerDefinition("cover", input),
    interiorReuseDefinition(input),
  ];
}

function interiorReuseDefinition(
  input: PrintJobDefinitionsInput,
): RegisteredJobDefinition {
  return {
    jobType: "print_interior_reuse",
    requestSchema: localJobRequestSchema,
    validateEnqueue: validatePrintReuseJob,
    prepare: async (job) => {
      const runId = job.inputSnapshot.runId;
      if (!runId) throw new JobError("JOB_REQUEST_SCHEMA_INVALID", 400);
      await input.production().guardRun(runId);
      return null;
    },
    execute: ({ signal }) =>
      signal.aborted
        ? Promise.resolve({ ok: false, failure: makeFailure("timeout") })
        : Promise.resolve({ ok: true, value: null }),
    commit: ({ job }) => {
      const result = input.production().commitReusedInterior(job);
      return {
        resultRefs: [
          result.artifact.id,
          result.artifact.assetId,
          result.run.id,
          ...(result.preflightJob ? [result.preflightJob.id] : []),
        ],
      };
    },
    normalizeError: normalizePrintJobError,
  };
}

function producerDefinition(
  kind: "interior" | "cover",
  input: PrintJobDefinitionsInput,
): RegisteredJobDefinition {
  return {
    jobType: kind === "interior" ? "print_interior" : "print_cover",
    requestSchema: localJobRequestSchema,
    validateEnqueue: validatePrintJob,
    prepare: async (job) => prepareProducer(kind, job, input),
    execute: ({ prepared, signal, timeoutMs }) =>
      executeProducer(prepared as PreparedProducer, signal, timeoutMs, input),
    commit: ({ job, value }) => {
      const executed = value as ExecutedProducer;
      const result = input.production().commitArtifact(job, executed.commit);
      return {
        resultRefs: [
          result.artifact.id,
          result.artifact.assetId,
          result.run.id,
          ...(result.preflightJob ? [result.preflightJob.id] : []),
        ],
      };
    },
    discard: async (value) => {
      const prepared = (value as Partial<ExecutedProducer>)?.commit
        ?.preparedAsset;
      if (prepared) await input.assets.discardPrepared(prepared);
    },
    normalizeError: normalizePrintJobError,
  };
}

async function prepareProducer(
  kind: "interior" | "cover",
  job: Readonly<JobRecord>,
  input: PrintJobDefinitionsInput,
): Promise<PreparedProducer> {
  const runId = job.inputSnapshot.runId;
  if (!runId) throw new JobError("JOB_REQUEST_SCHEMA_INVALID", 400);
  const context = await input.production().guardRun(runId);
  const document =
    kind === "interior"
      ? await input.compiler().compileInterior(context)
      : await input.compiler().compileCover(context);
  return { kind, context, document };
}

async function executeProducer(
  prepared: PreparedProducer,
  signal: AbortSignal,
  timeoutMs: number,
  input: PrintJobDefinitionsInput,
): Promise<JobExecutionResult> {
  if (signal.aborted) return { ok: false, failure: makeFailure("timeout") };
  let stored: PreparedAsset | null = null;
  try {
    const render = await renderPrepared(prepared, signal, input);
    if (signal.aborted) return { ok: false, failure: makeFailure("timeout") };
    const converted = await maybeConvert(
      prepared.context,
      render,
      signal,
      timeoutMs,
      input,
    );
    const pdfBytes = converted?.pdfBytes ?? render.pdfBytes;
    stored = await preparePdfAsset(prepared.kind, pdfBytes, input.assets);
    const stale = await producerBecameStale(prepared, input);
    if (signal.aborted) {
      await input.assets.discardPrepared(stored);
      stored = null;
      return { ok: false, failure: makeFailure("timeout") };
    }
    if (stale) {
      await input.assets.discardPrepared(stored);
      stored = null;
      return { ok: false, failure: makeFailure("stale_dependency") };
    }
    const commit = producerCommit(prepared, stored, render, converted);
    return { ok: true, value: { commit } satisfies ExecutedProducer };
  } catch (error) {
    if (stored) await input.assets.discardPrepared(stored);
    throw error;
  }
}

async function renderPrepared(
  prepared: PreparedProducer,
  signal: AbortSignal,
  input: PrintJobDefinitionsInput,
): Promise<PrintRenderResult | PrintCoverRenderResult> {
  return prepared.kind === "interior"
    ? await (input.renderer?.interior ?? renderPrintInterior)(
        prepared.document as PrintInteriorDocument,
        { signal },
      )
    : await (input.renderer?.cover ?? renderPrintCover)(
        prepared.document as PrintCoverDocument,
        { signal },
      );
}

async function preparePdfAsset(
  kind: PreparedProducer["kind"],
  bytes: Buffer,
  assets: AssetStore,
): Promise<PreparedAsset> {
  return assets.prepare({
    bytes,
    extension: "pdf",
    mime: "application/pdf",
    role: kind === "interior" ? "pdf_interior" : "pdf_cover",
    origin: "derived",
  });
}

async function producerBecameStale(
  prepared: PreparedProducer,
  input: PrintJobDefinitionsInput,
): Promise<boolean> {
  const current = await input.production().guardRun(prepared.context.run.id);
  return current.sourceSnapshotHash !== prepared.context.sourceSnapshotHash;
}

function producerCommit(
  prepared: PreparedProducer,
  stored: PreparedAsset,
  render: PrintRenderResult | PrintCoverRenderResult,
  converted: CmykConversionResult | null,
): PreparedPrintArtifactCommit {
  const renderFacts = printRenderFacts(prepared.kind, render);
  const run = prepared.context.run;
  const color = prepared.context.profileVersion.color;
  return {
    kind: prepared.kind,
    runId: run.id,
    preparedAsset: stored,
    contentAuthorizationHash: run.contentAuthorizationHash,
    printerProfileVersionId: run.printerProfileVersionId,
    printerProfileHash: run.printerProfileHash,
    sourceSnapshotHash: run.sourceSnapshotHash,
    pageMapHash: documentMapHash(prepared.document),
    colorMode: color.mode,
    iccChecksum: color.mode === "cmyk" ? color.iccChecksum : null,
    rendererVersion: PRINT_RENDERER_VERSION,
    converterVersion: converted?.converterVersion ?? null,
    fontPolicyVersion: PRINT_FONT_POLICY_VERSION,
    renderFactsHash: hashCanonical(renderFacts),
    renderFacts,
    conversionFacts: converted ? conversionFacts(converted) : null,
  };
}

function printRenderFacts(
  kind: PreparedProducer["kind"],
  render: PrintRenderResult | PrintCoverRenderResult,
) {
  return {
    pageCount: render.pageCount,
    egressRequestCount: 0 as const,
    overflowPageNumbers: render.overflowPageNumbers,
    watermarkCount: 0 as const,
    minimumImagePpi: render.minimumImagePpi,
    fontNames: render.fontNames,
    panelOrder:
      kind === "cover" ? (render as PrintCoverRenderResult).panelOrder : null,
  };
}

async function maybeConvert(
  context: MaterializationContext,
  render: PrintRenderResult,
  signal: AbortSignal,
  timeoutMs: number,
  input: PrintJobDefinitionsInput,
): Promise<CmykConversionResult | null> {
  if (context.profileVersion.color.mode === "rgb") return null;
  const iccBytes = await input.assets.read(
    context.profileVersion.color.iccAssetId,
  );
  return await (input.cmyk?.convert ?? convertPdfToCmyk)({
    pdfBytes: render.pdfBytes,
    iccBytes,
    expectedIccChecksum: context.profileVersion.color.iccChecksum,
    signal,
    timeoutMs,
  });
}

function documentMapHash(
  document: PrintInteriorDocument | PrintCoverDocument,
): string {
  return document.kind === "interior"
    ? hashCanonical(document.pages.map((page) => page.map))
    : hashCanonical(document.panels.map((panel) => panel.kind));
}

function conversionFacts(converted: CmykConversionResult) {
  return {
    outputConditionIdentifier: converted.outputConditionIdentifier,
    embeddedIccChecksum: converted.embeddedIccChecksum,
    embeddedIccBytes: converted.embeddedIccBytes,
    imageCount: converted.imageCount,
    contentStreamCount: converted.contentStreamCount,
    cmykOnly: true as const,
    outputIntentMatches: true as const,
    geometryPreserved: true as const,
    fontsPreserved: true as const,
  };
}

function validatePrintJob(job: Readonly<EnqueueJobInput>): void {
  if (
    job.target !== null ||
    !job.projectId ||
    job.request.kind !== "local" ||
    !job.inputSnapshot.runId ||
    !job.inputSnapshot.contentAuthorizationHash ||
    !job.inputSnapshot.printerProfileVersionId ||
    !job.inputSnapshot.printerProfileHash ||
    !job.inputSnapshot.sourceSnapshotHash
  )
    throw new JobError("JOB_REQUEST_SCHEMA_INVALID", 400);
}

function validatePrintReuseJob(job: Readonly<EnqueueJobInput>): void {
  validatePrintJob(job);
  if (
    !job.inputSnapshot.reusedArtifactId ||
    !job.inputSnapshot.reusedArtifactChecksum ||
    !job.inputSnapshot.sourceRunId ||
    !job.inputSnapshot.interiorProfileHash
  )
    throw new JobError("JOB_REQUEST_SCHEMA_INVALID", 400);
}

function normalizePrintJobError(error: unknown): NormalizedFailure {
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "ABORT_ERR")
  )
    return makeFailure("timeout");
  if (error instanceof ApprovalError)
    return makeFailure("stale_dependency", { reasonCode: error.code });
  if (error instanceof PrintError)
    return makeFailure("stale_dependency", { reasonCode: error.code });
  if (error instanceof CmykConversionError)
    return makeFailure("output_validation_failed", {
      reasonCode: error.code,
    });
  return makeFailure("output_validation_failed", {
    reasonCode: "PRINT_PRODUCTION_FAILED",
  });
}
