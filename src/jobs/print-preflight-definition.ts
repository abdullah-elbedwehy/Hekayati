import { ulid } from "ulid";

import type { AssetStore, PreparedAsset } from "../assets/asset-store.js";
import {
  compileCoverGeometry,
  compileInteriorGeometry,
  compileOutputPageMap,
  type OutputPageMapEntry,
} from "../domain/print/geometry.js";
import { hashCanonical } from "../domain/layout/hashes.js";
import { PRINT_PREFLIGHT_POLICY_VERSION } from "../domain/print/preflight.js";
import { PrintRepositories } from "../domain/print/repositories.js";
import type {
  PrintArtifact,
  PrintPreflightReport,
  PrintRun,
} from "../domain/print/schemas.js";
import type {
  MaterializationContext,
  PreparedPrintPreflightCommit,
  PrintProductionService,
} from "../domain/print/workflow.js";
import type { DocumentStore } from "../domain/repository/document-store.js";
import {
  preflightPrintBundle,
  type PdfMechanicalFacts,
} from "../pdf/print-preflight.js";
import { createPrintProofRasters } from "../pdf/print-proof.js";
import {
  PRINT_FONT_POLICY_VERSION,
  type PrintCoverRenderResult,
  type PrintRenderResult,
} from "../pdf/print-renderer.js";
import { makeFailure, type NormalizedFailure } from "../providers/failures.js";
import { JobError } from "./errors.js";
import { localJobRequestSchema, type JobRecord } from "./schemas.js";
import type {
  EnqueueJobInput,
  JobExecutionResult,
  RegisteredJobDefinition,
} from "./types.js";

export interface PrintPreflightDefinitionInput {
  store: DocumentStore;
  assets: AssetStore;
  production: () => PrintProductionService;
  now?: () => string;
  idFactory?: () => string;
  pdftoppm?: string;
  preflight?: typeof preflightPrintBundle;
}

interface PreparedPreflight {
  context: MaterializationContext & { run: PrintRun };
  interior: PrintArtifact;
  cover: PrintArtifact;
  interiorPdf: Buffer;
  coverPdf: Buffer;
  pageMap: OutputPageMapEntry[];
}

interface ExecutedPreflight {
  commit: PreparedPrintPreflightCommit;
}

export function createPrintPreflightDefinition(
  input: PrintPreflightDefinitionInput,
): RegisteredJobDefinition {
  const print = new PrintRepositories(input.store);
  const now = input.now ?? (() => new Date().toISOString());
  const idFactory = input.idFactory ?? ulid;
  return {
    jobType: "print_preflight",
    requestSchema: localJobRequestSchema,
    validateEnqueue: validatePreflightJob,
    prepare: async (job) => preparePreflight(job, input, print),
    execute: ({ prepared, signal }) =>
      executePreflight(
        prepared as PreparedPreflight,
        signal,
        input,
        now,
        idFactory,
      ),
    commit: ({ job, value }) => {
      const result = input
        .production()
        .commitPreflight(job, (value as ExecutedPreflight).commit);
      return {
        resultRefs: [
          result.run.id,
          result.report.id,
          ...(result.proofBundle ? [result.proofBundle.id] : []),
          ...(result.proofGate ? [result.proofGate.id] : []),
        ],
      };
    },
    discard: async (value) => {
      const proof = (value as Partial<ExecutedPreflight>)?.commit?.proof;
      if (proof)
        await Promise.all(
          proof.rasters.map((raster) =>
            input.assets.discardPrepared(raster.prepared),
          ),
        );
    },
    normalizeError: normalizePreflightError,
  };
}

async function preparePreflight(
  job: Readonly<JobRecord>,
  input: PrintPreflightDefinitionInput,
  print: PrintRepositories,
): Promise<PreparedPreflight> {
  const runId = job.inputSnapshot.runId;
  if (!runId) throw new JobError("JOB_REQUEST_SCHEMA_INVALID", 400);
  const context = await input.production().guardRun(runId);
  const interiorId = context.run.currentInteriorArtifactId;
  const coverId = context.run.currentCoverArtifactId;
  const interior = interiorId ? print.artifacts.get(interiorId) : null;
  const cover = coverId ? print.artifacts.get(coverId) : null;
  if (
    context.run.state !== "preflight_pending" ||
    context.run.preflightJobId !== job.id ||
    !interior ||
    !cover ||
    interior.kind !== "interior" ||
    cover.kind !== "cover"
  )
    throw new Error("PRINT_PREFLIGHT_STALE");
  const pageMap = compileOutputPageMap(
    context.snapshot.orderedInteriorPages.map((page) => ({
      customerPageNumber: page.pageNumber,
      pageId: page.pageId,
    })),
    context.profileVersion.requiredBlankPages,
  );
  const [interiorPdf, coverPdf] = await Promise.all([
    input.assets.read(interior.assetId),
    input.assets.read(cover.assetId),
  ]);
  return { context, interior, cover, interiorPdf, coverPdf, pageMap };
}

async function executePreflight(
  prepared: PreparedPreflight,
  signal: AbortSignal,
  input: PrintPreflightDefinitionInput,
  now: () => string,
  idFactory: () => string,
): Promise<JobExecutionResult> {
  if (signal.aborted) return { ok: false, failure: makeFailure("timeout") };
  let proofAssets: PreparedPrintPreflightCommit["proof"] = null;
  try {
    const cmyk = cmykExpectation(prepared.interior, prepared.cover);
    const mechanical = await runMechanicalPreflight(
      prepared,
      cmyk,
      input.preflight ?? preflightPrintBundle,
      input.pdftoppm,
    );
    if (signal.aborted) return { ok: false, failure: makeFailure("timeout") };
    const report = buildPreflightReport(
      prepared,
      mechanical,
      cmyk,
      now(),
      idFactory(),
    );
    proofAssets = await prepareProofAssets(prepared, report, input, idFactory);
    const failure = await preflightCompletionFailure(prepared, signal, input);
    if (failure) {
      await discardProof(proofAssets, input.assets);
      proofAssets = null;
      return { ok: false, failure };
    }
    return {
      ok: true,
      value: {
        commit: {
          runId: prepared.context.run.id,
          report,
          proof: proofAssets,
        },
      } satisfies ExecutedPreflight,
    };
  } catch (error) {
    await discardProof(proofAssets, input.assets);
    throw error;
  }
}

async function preflightCompletionFailure(
  prepared: PreparedPreflight,
  signal: AbortSignal,
  input: PrintPreflightDefinitionInput,
): Promise<NormalizedFailure | null> {
  if (signal.aborted) return makeFailure("timeout");
  const stale = await preflightBecameStale(prepared, input);
  if (signal.aborted) return makeFailure("timeout");
  return stale ? makeFailure("stale_dependency") : null;
}

type MechanicalPreflight = Awaited<ReturnType<typeof preflightPrintBundle>>;
type CmykExpectation = ReturnType<typeof cmykExpectation>;

async function runMechanicalPreflight(
  prepared: PreparedPreflight,
  cmyk: CmykExpectation,
  preflight: typeof preflightPrintBundle,
  pdftoppm?: string,
): Promise<MechanicalPreflight> {
  const profile = prepared.context.profileVersion;
  return preflight({
    interiorPdf: prepared.interiorPdf,
    coverPdf: prepared.coverPdf,
    interiorRender: renderResult(prepared.interior),
    coverRender: coverResult(prepared.cover),
    profile,
    interiorGeometry: compileInteriorGeometry(profile),
    coverGeometry: compileCoverGeometry(profile),
    pageMap: prepared.pageMap,
    expectedPageMapHash: hashCanonical(prepared.pageMap),
    actualPageMapHash: prepared.interior.pageMapHash,
    blanksMatch: true,
    sourceAssetsPresent: true,
    sourceChecksumsMatch: true,
    previewWatermarkPresent:
      prepared.context.output.validationReport.pageResults.every(
        (page) => page.watermarkPresent,
      ),
    expectedContentAuthorizationHash:
      prepared.context.run.contentAuthorizationHash,
    actualContentAuthorizationHash: sharedAuthorization(prepared),
    expectedProfileHash: prepared.context.run.printerProfileHash,
    actualProfileHash: sharedProfileHash(prepared),
    ...(cmyk ? { cmyk } : {}),
    ...(pdftoppm ? { tools: { pdftoppm } } : {}),
  });
}

function buildPreflightReport(
  prepared: PreparedPreflight,
  mechanical: MechanicalPreflight,
  cmyk: CmykExpectation,
  at: string,
  id: string,
): PrintPreflightReport {
  const measurements = preflightMeasurements(prepared, mechanical, cmyk);
  return {
    id,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    projectId: prepared.context.run.projectId,
    ...artifactReportBinding(prepared),
    contentAuthorizationHash: prepared.context.run.contentAuthorizationHash,
    printerProfileVersionId: prepared.context.run.printerProfileVersionId,
    printerProfileHash: prepared.context.run.printerProfileHash,
    policyVersion: PRINT_PREFLIGHT_POLICY_VERSION,
    toolVersions: {
      ...mechanical.toolVersions,
      renderer: prepared.interior.rendererVersion,
      converter: prepared.interior.converterVersion ?? "not-applicable-rgb",
    },
    findings: mechanical.evaluation.findings,
    measurements,
    measurementsHash: hashCanonical(measurements),
    passed: mechanical.evaluation.passed,
  };
}

function preflightMeasurements(
  prepared: PreparedPreflight,
  mechanical: MechanicalPreflight,
  cmyk: CmykExpectation,
): PrintPreflightReport["measurements"] {
  const color = prepared.context.profileVersion.color;
  const coverGeometry = compileCoverGeometry(prepared.context.profileVersion);
  return {
    pageMap: prepared.pageMap,
    interior: persistedPdfFacts(mechanical.interior),
    cover: persistedPdfFacts(mechanical.cover),
    sourceAssets: prepared.context.sourceAssets,
    outputChecksums: {
      interior: prepared.interior.checksum,
      cover: prepared.cover.checksum,
    },
    coverSpread: {
      panelOrder: coverResult(prepared.cover).panelOrder,
      spineWidthMm: coverGeometry.spineWidthMm,
      panels: coverGeometry.panels.map(({ kind, boxMm }) => ({ kind, boxMm })),
      foldLinesMm: coverGeometry.foldLinesMm,
    },
    cropMarks: {
      ...prepared.context.profileVersion.cropMarks,
      interiorSegmentCount: minimumDetectedCropMarks(mechanical.interior),
      coverSegmentCount: minimumDetectedCropMarks(mechanical.cover),
    },
    colorMode: color.mode,
    iccChecksum: color.mode === "cmyk" ? color.iccChecksum : null,
    outputIntentMatches:
      color.mode === "rgb" || Boolean(cmyk?.outputIntentMatches),
  };
}

async function prepareProofAssets(
  prepared: PreparedPreflight,
  report: PrintPreflightReport,
  input: PrintPreflightDefinitionInput,
  idFactory: () => string,
): Promise<PreparedPrintPreflightCommit["proof"]> {
  if (!report.passed || prepared.context.profileVersion.color.mode !== "cmyk")
    return null;
  const rasters = await createPrintProofRasters(
    prepared.interiorPdf,
    prepared.coverPdf,
    input.pdftoppm,
  );
  const stored: PreparedAsset[] = [];
  try {
    for (const raster of rasters)
      stored.push(await prepareProofRaster(raster, input.assets));
  } catch (error) {
    await discardPreparedAssets(stored, input.assets);
    throw error;
  }
  const [interior, cover] = stored;
  if (!interior || !cover) {
    await discardPreparedAssets(stored, input.assets);
    throw new Error("PRINT_PROOF_RASTER_COUNT_INVALID");
  }
  return {
    bundleId: idFactory(),
    gateId: idFactory(),
    rasters: [
      { kind: "interior", prepared: interior },
      { kind: "cover", prepared: cover },
    ],
  };
}

async function prepareProofRaster(
  raster: Awaited<ReturnType<typeof createPrintProofRasters>>[number],
  assets: AssetStore,
): Promise<PreparedAsset> {
  return assets.prepare({
    bytes: raster.bytes,
    extension: "png",
    mime: "image/png",
    role: "print_proof",
    origin: "derived",
    width: raster.widthPx,
    height: raster.heightPx,
  });
}

async function preflightBecameStale(
  prepared: PreparedPreflight,
  input: PrintPreflightDefinitionInput,
): Promise<boolean> {
  const current = await input.production().guardRun(prepared.context.run.id);
  return current.sourceSnapshotHash !== prepared.context.sourceSnapshotHash;
}

function sharedAuthorization(prepared: PreparedPreflight): string {
  return prepared.interior.contentAuthorizationHash ===
    prepared.cover.contentAuthorizationHash
    ? prepared.interior.contentAuthorizationHash
    : "0".repeat(64);
}

function sharedProfileHash(prepared: PreparedPreflight): string {
  return prepared.interior.printerProfileHash ===
    prepared.cover.printerProfileHash
    ? prepared.interior.printerProfileHash
    : "0".repeat(64);
}

function artifactReportBinding(prepared: PreparedPreflight) {
  return {
    runId: prepared.context.run.id,
    interiorArtifactId: prepared.interior.id,
    interiorChecksum: prepared.interior.checksum,
    coverArtifactId: prepared.cover.id,
    coverChecksum: prepared.cover.checksum,
  };
}

function renderResult(artifact: PrintArtifact): PrintRenderResult {
  if (artifact.fontPolicyVersion !== PRINT_FONT_POLICY_VERSION)
    throw new Error("PRINT_PREFLIGHT_FONT_POLICY_MISMATCH");
  return {
    pdfBytes: Buffer.alloc(0),
    pageCount: artifact.renderFacts.pageCount,
    egressRequestCount: 0,
    blockedRequests: [],
    overflowPageNumbers: artifact.renderFacts.overflowPageNumbers,
    watermarkCount: 0,
    minimumImagePpi: artifact.renderFacts.minimumImagePpi,
    fontNames: artifact.renderFacts.fontNames,
    rendererVersion: artifact.rendererVersion,
    fontPolicyVersion: PRINT_FONT_POLICY_VERSION,
    renderFactsHash: artifact.renderFactsHash,
  };
}

function coverResult(artifact: PrintArtifact): PrintCoverRenderResult {
  const panelOrder = artifact.renderFacts.panelOrder;
  if (!panelOrder) throw new Error("PRINT_PREFLIGHT_COVER_FACTS_MISSING");
  return { ...renderResult(artifact), panelOrder };
}

function cmykExpectation(interior: PrintArtifact, cover: PrintArtifact) {
  if (interior.colorMode === "rgb" && cover.colorMode === "rgb") return null;
  const facts = [interior.conversionFacts, cover.conversionFacts];
  return {
    conversionPassed: facts.every(Boolean),
    iccPresent:
      Boolean(interior.iccChecksum) &&
      interior.iccChecksum === cover.iccChecksum,
    outputIntentMatches: facts.every((fact) => fact?.outputIntentMatches),
    cmykOnly: facts.every((fact) => fact?.cmykOnly),
  };
}

function persistedPdfFacts(facts: PdfMechanicalFacts) {
  return {
    pageCount: facts.pageCount,
    encrypted: facts.encrypted,
    parseable: facts.parseable,
    mediaBoxMm: facts.mediaBoxMm,
    bleedBoxMm: facts.bleedBoxMm,
    trimBoxMm: facts.trimBoxMm,
    pageBoxes: facts.pageBoxes,
    fonts: facts.fonts,
    imageCount: facts.imageCount,
    imagePpi: facts.imagePpi,
    minimumImagePpi: facts.minimumImagePpi,
    textBounds: facts.textBounds,
    cropMarkSegments: facts.cropMarkSegments,
    hasArabicText: facts.hasArabicText,
    arabicGlyphCount: facts.arabicGlyphCount,
    unmappedGlyphCount: facts.unmappedGlyphCount,
    watermarkCount: facts.printWatermarkCount,
    watermarkPages: facts.printWatermarkPages,
    prohibitedFeatureCount: facts.prohibitedFeatureCount,
    externalResourceCount: facts.externalResourceCount,
    hasDeviceRgb: facts.hasDeviceRgb,
    hasDeviceCmyk: facts.hasDeviceCmyk,
  };
}

function minimumDetectedCropMarks(facts: PdfMechanicalFacts): number {
  return facts.cropMarkSegments.length
    ? Math.min(
        ...facts.cropMarkSegments.map((page) => page.detectedSegmentCount),
      )
    : 0;
}

async function discardProof(
  proof: PreparedPrintPreflightCommit["proof"],
  assets: AssetStore,
): Promise<void> {
  if (!proof) return;
  await discardPreparedAssets(
    proof.rasters.map((raster) => raster.prepared),
    assets,
  );
}

async function discardPreparedAssets(
  prepared: readonly PreparedAsset[],
  assets: AssetStore,
): Promise<void> {
  await Promise.all(prepared.map((asset) => assets.discardPrepared(asset)));
}

function validatePreflightJob(job: Readonly<EnqueueJobInput>): void {
  if (
    job.target !== null ||
    !job.projectId ||
    job.request.kind !== "local" ||
    !job.inputSnapshot.runId ||
    !job.inputSnapshot.interiorArtifactId ||
    !job.inputSnapshot.interiorChecksum ||
    !job.inputSnapshot.coverArtifactId ||
    !job.inputSnapshot.coverChecksum ||
    !job.inputSnapshot.contentAuthorizationHash ||
    !job.inputSnapshot.printerProfileHash
  )
    throw new JobError("JOB_REQUEST_SCHEMA_INVALID", 400);
}

function normalizePreflightError(error: unknown): NormalizedFailure {
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "ABORT_ERR")
  )
    return makeFailure("timeout");
  if (error instanceof JobError)
    return makeFailure(
      error.code.includes("STALE") ? "stale_dependency" : "invalid_input",
      { reasonCode: error.code },
    );
  if (error instanceof Error && error.name === "ZodError")
    return makeFailure("output_validation_failed", {
      reasonCode: preflightSchemaReason(error),
    });
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,79}$/u.test(error.message))
    return makeFailure("output_validation_failed", {
      reasonCode: error.message,
    });
  return makeFailure("output_validation_failed", {
    reasonCode: "PRINT_PREFLIGHT_FAILED",
  });
}

function preflightSchemaReason(error: Error): string {
  const issues = (
    error as Error & {
      issues?: Array<{ message?: unknown; path?: unknown }>;
    }
  ).issues;
  if (!Array.isArray(issues)) return "PRINT_PREFLIGHT_REPORT_SCHEMA_INVALID";
  const explicit = issues.find(
    (issue) =>
      typeof issue.message === "string" &&
      /^PRINT_[A-Z0-9_]{2,72}$/u.test(issue.message),
  )?.message;
  if (typeof explicit === "string") return explicit;
  const paths = issues.flatMap((issue) =>
    Array.isArray(issue.path) ? issue.path.map(String) : [],
  );
  if (paths.some((part) => part.includes("UnsafeWord")))
    return "PRINT_PREFLIGHT_UNSAFE_WORD_FACTS_INVALID";
  if (paths.includes("textBounds"))
    return "PRINT_PREFLIGHT_TEXT_BOUNDS_FACTS_INVALID";
  if (paths.includes("coverSpread"))
    return "PRINT_PREFLIGHT_COVER_SPREAD_FACTS_INVALID";
  return "PRINT_PREFLIGHT_REPORT_SCHEMA_INVALID";
}
