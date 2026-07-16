import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { AssetStore } from "../../src/assets/asset-store.js";
import { LOOPBACK_HOST } from "../../src/config/defaults.js";
import { resolveDataPaths } from "../../src/config/paths.js";
import { initializeLayoutPersistence } from "../../src/domain/layout/migrations.js";
import {
  cleanPreflightFacts,
  evaluatePreflightFacts,
} from "../../src/domain/print/preflight.js";
import { createDefaultPrinterProfileDraft } from "../../src/domain/print/schemas.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { createRuntime } from "../../src/server/app.js";
import type { PrintJobPorts } from "../../src/server/print-runtime.js";
import {
  renderPrintCover,
  renderPrintInterior,
} from "../../src/pdf/print-renderer.js";
import {
  preflightPrintBundle,
  type PdfMechanicalFacts,
  type PrintPreflightInput,
} from "../../src/pdf/print-preflight.js";
import { convertPdfToCmyk } from "../../src/print/cmyk.js";
import { seedCreativeProject } from "../helpers/creative-fixtures.js";
import { seedReviewedPages } from "../helpers/layout-workflow-fixture.js";
import { syntheticPreviewSource } from "../helpers/preview-fixtures.js";

const dataDir = process.env.HEKAYATI_DATA_DIR;
if (!dataDir) throw new Error("HEKAYATI_DATA_DIR_REQUIRED");
const mode = process.env.HEKAYATI_PRINT_MODE ?? "resume";
const fastFixture = process.env.HEKAYATI_PRINT_FAST_FIXTURE === "1";
const faultStage = printFaultStage(process.env.HEKAYATI_PRINT_FAULT_STAGE);
const statePath = join(dataDir, "print-e2e-fixture.json");
const state =
  mode === "seed"
    ? await seedPrintFixture(dataDir, statePath)
    : JSON.parse(await readFile(statePath, "utf8"));
const runtime = await createRuntime({
  dataDir,
  enableTestRoutes: true,
  ...(faultStage
    ? { assetStoreHooks: faultAssetHooks(dataDir, faultStage) }
    : {}),
  ...(faultStage || fastFixture
    ? {
        printJobs: faultStage
          ? faultPrintPorts(dataDir, faultStage)
          : fastPrintPorts(),
      }
    : {}),
  jobs: {
    pollIntervalMs: 2,
    maxWorkers: 2,
    heartbeatIntervalMs: 25,
    leaseTtlMs: 250,
  },
});
const origin = await runtime.start({
  host: LOOPBACK_HOST,
  port: Number(process.env.HEKAYATI_PORT ?? "4317"),
});
if (mode === "seed") runtime.layout.workflow.start(state.projectId);
console.log(`Hekayati is ready at ${origin}`);
const autoStart = process.env.HEKAYATI_PRINT_AUTOSTART;
if (mode === "seed" && (autoStart === "rgb" || autoStart === "cmyk"))
  void autoStartPrint(runtime, state.projectId, state.scope, autoStart).catch(
    (error) => recordAutostartFailure(dataDir, error),
  );

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runtime.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

async function seedPrintFixture(dataDirectory: string, stateFile: string) {
  const seed = await seedCreativeProject(dataDirectory, "-print-e2e");
  const paths = resolveDataPaths(dataDirectory);
  const store = new DocumentStore(paths.database);
  initializeLayoutPersistence(store);
  const assets = new AssetStore(store, paths.assets);
  const previewSource = await syntheticPreviewSource();
  const sourceBytes = fastFixture
    ? previewSource
    : await sharp(previewSource)
        .resize(2_600, 3_677, { fit: "fill" })
        .jpeg({ quality: 82, chromaSubsampling: "4:4:4" })
        .toBuffer();
  const source = await assets.put({
    bytes: sourceBytes,
    extension: fastFixture ? "png" : "jpg",
    mime: fastFixture ? "image/png" : "image/jpeg",
    role: "illustration",
    origin: "derived",
    width: fastFixture ? 1_400 : 2_600,
    height: fastFixture ? 1_900 : 3_677,
    dpi: 300,
  });
  seedReviewedPages(store, seed.projectId, source.id);
  store.close();
  await writeFile(stateFile, JSON.stringify(seed), {
    encoding: "utf8",
    mode: 0o600,
  });
  return seed;
}

type PrintFaultStage =
  | "interior_render"
  | "cover_render"
  | "cmyk_conversion"
  | "validation"
  | "after_temp_sync"
  | "after_rename_before_db";

function printFaultStage(value: string | undefined): PrintFaultStage | null {
  const stages: PrintFaultStage[] = [
    "interior_render",
    "cover_render",
    "cmyk_conversion",
    "validation",
    "after_temp_sync",
    "after_rename_before_db",
  ];
  if (!value) return null;
  if (!stages.includes(value as PrintFaultStage))
    throw new Error("HEKAYATI_PRINT_FAULT_STAGE_INVALID");
  return value as PrintFaultStage;
}

function faultPrintPorts(
  directory: string,
  stage: PrintFaultStage,
): PrintJobPorts {
  const base = fastFixture ? fastPrintPorts() : productionPrintPorts();
  return {
    renderer: {
      interior: (document) =>
        faultDuring(directory, stage, "interior_render", () =>
          base.renderer.interior(document),
        ),
      cover: (document) =>
        faultDuring(directory, stage, "cover_render", () =>
          base.renderer.cover(document),
        ),
    },
    cmyk: {
      convert: async (input) => {
        if (stage === "cmyk_conversion") {
          await markFault(directory, stage);
          await new Promise<never>(() => undefined);
        }
        return base.cmyk.convert(input);
      },
    },
    preflight: (input) =>
      faultDuring(directory, stage, "validation", () => base.preflight(input)),
  };
}

function productionPrintPorts(): Required<PrintJobPorts> {
  return {
    renderer: {
      interior: renderPrintInterior,
      cover: renderPrintCover,
    },
    cmyk: { convert: convertPdfToCmyk },
    preflight: preflightPrintBundle,
  };
}

function fastPrintPorts(): Required<PrintJobPorts> {
  const interiorPdf = minimalPdf("interior");
  const coverPdf = minimalPdf("cover");
  const render = (pdfBytes: Buffer, pageCount: number) => ({
    pdfBytes,
    pageCount,
    egressRequestCount: 0 as const,
    blockedRequests: [],
    overflowPageNumbers: [],
    watermarkCount: 0 as const,
    minimumImagePpi: 72,
    fontNames: ["IBMPlexSansArabic", "Lemonada"],
    rendererVersion: "hekayati.print.chromium.v1" as const,
    fontPolicyVersion: "hekayati.print-fonts.v1" as const,
    renderFactsHash: "f".repeat(64),
  });
  return {
    renderer: {
      interior: async (document) => render(interiorPdf, document.pages.length),
      cover: async () => ({
        ...render(coverPdf, 1),
        panelOrder: ["back", "spine", "front"] as const,
      }),
    },
    cmyk: {
      convert: async (input) => ({
        pdfBytes: input.pdfBytes,
        iccChecksum: input.expectedIccChecksum,
        outputConditionIdentifier: "synthetic-fast-cmyk",
        embeddedIccChecksum: input.expectedIccChecksum,
        embeddedIccBytes: input.iccBytes.length,
        imageCount: 0,
        contentStreamCount: 1,
        pageCount: 1,
        cmykOnly: true,
        outputIntentMatches: true,
        geometryPreserved: true,
        fontsPreserved: true,
        converterVersion: "hekayati.test-fast-cmyk.v1",
      }),
    },
    preflight: fastPreflight,
  };
}

async function fastPreflight(
  input: PrintPreflightInput,
): Promise<Awaited<ReturnType<typeof preflightPrintBundle>>> {
  const facts = structuredClone(cleanPreflightFacts);
  return {
    evaluation: evaluatePreflightFacts(facts),
    facts,
    interior: fastMechanicalFacts(input.pageMap.length, input.interiorGeometry),
    cover: fastMechanicalFacts(1, input.coverGeometry),
    toolVersions: {
      qpdf: "synthetic-fast",
      pdfinfo: "synthetic-fast",
      pdffonts: "synthetic-fast",
      pdfimages: "synthetic-fast",
      pdftotext: "synthetic-fast",
      pdftoppm: "synthetic-fast",
    },
  };
}

function fastMechanicalFacts(
  pageCount: number,
  geometry: PrintPreflightInput["interiorGeometry"],
): PdfMechanicalFacts {
  return {
    pageCount,
    encrypted: false,
    parseable: true,
    mediaBoxMm: geometry.mediaBoxMm,
    bleedBoxMm: geometry.bleedBoxMm,
    trimBoxMm: geometry.trimBoxMm,
    pageBoxes: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      rotation: 0,
      mediaBoxMm: geometry.mediaBoxMm,
      bleedBoxMm: geometry.bleedBoxMm,
      trimBoxMm: geometry.trimBoxMm,
      portrait: geometry.mediaBoxMm.width < geometry.mediaBoxMm.height,
    })),
    fonts: [
      {
        name: "IBMPlexSansArabic",
        embedded: true,
        subset: true,
        toUnicode: true,
      },
      { name: "Lemonada", embedded: true, subset: true, toUnicode: true },
    ],
    imageCount: pageCount,
    imagePpi: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      imageCount: 1,
      minimumPpi: 300,
    })),
    minimumImagePpi: 300,
    textBounds: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      wordCount: 1,
      boundsMm: geometry.safeBoxMm,
      unsafeWordCount: 0,
      firstUnsafeWordBoundsMm: null,
    })),
    cropMarkSegments: Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      detectedSegmentCount: geometry.cropMarks.length,
    })),
    extractedTextLength: 12,
    hasArabicText: true,
    arabicGlyphCount: 12,
    unmappedGlyphCount: 0,
    printWatermarkCount: 0,
    printWatermarkPages: [],
    prohibitedFeatureCount: 0,
    externalResourceCount: 0,
    hasDeviceRgb: true,
    hasDeviceCmyk: false,
  };
}

function minimalPdf(label: "interior" | "cover"): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let body = `%PDF-1.4\n% synthetic-${label}\n`;
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function faultAssetHooks(directory: string, stage: PrintFaultStage) {
  const block = async (
    expected: "after_temp_sync" | "after_rename_before_db",
    boundary: { role: string },
  ) => {
    if (
      stage !== expected ||
      (boundary.role !== "pdf_interior" && boundary.role !== "pdf_cover")
    )
      return;
    await markFault(directory, stage);
    await new Promise<never>(() => undefined);
  };
  return {
    afterTempSync: (boundary: { role: string }) =>
      block("after_temp_sync", boundary),
    afterRenameSync: (boundary: { role: string }) =>
      block("after_rename_before_db", boundary),
  };
}

async function faultDuring<T>(
  directory: string,
  configured: PrintFaultStage,
  expected: PrintFaultStage,
  operation: () => Promise<T>,
): Promise<T> {
  if (configured === expected) {
    await markFault(directory, configured);
    await new Promise<never>(() => undefined);
  }
  return operation();
}

function markFault(directory: string, stage: PrintFaultStage): Promise<void> {
  return writeFile(join(directory, `print-fault-${stage}.ready`), stage, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function autoStartPrint(
  app: Awaited<ReturnType<typeof createRuntime>>,
  projectId: string,
  scope: { customerId: string; familyId: string },
  colorMode: "rgb" | "cmyk",
): Promise<void> {
  let projection = await waitForLayoutReady(app, projectId);
  app.layout.approvals.act(
    approvalInput(projection, scope, "preview_sent", "fault-send"),
  );
  projection = app.layout.workspace.project(projectId);
  app.layout.approvals.act(
    approvalInput(projection, scope, "approved", "fault-approve"),
  );

  const imported =
    colorMode === "cmyk"
      ? await app.print.profiles.importIcc({
          bytes: await readFile(
            "/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc",
          ),
          requireCmyk: true,
        })
      : null;
  const profile = app.print.profiles.create({
    name: `Synthetic ${colorMode.toUpperCase()} restart profile`,
    draft: {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit", widthMm: 8 },
      ...(imported
        ? {
            color: {
              mode: "cmyk" as const,
              iccAssetId: imported.asset.id,
              iccChecksum: imported.asset.sha256,
            },
          }
        : {}),
    },
  });
  const project = app.print.workspace.project(scope, projectId).project;
  app.print.profiles.assignProject({
    owner: scope,
    projectId,
    expectedProjectRevision: project.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
  });
  const authorization = await app.layout.approvedSnapshots.read(projectId);
  const assigned = app.print.workspace.project(scope, projectId).project;
  await app.print.production.start({
    owner: scope,
    projectId,
    expectedProjectRevision: assigned.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
    contentAuthorizationHash: authorization.contentAuthorizationHash,
    idempotencyKey: `fault-${colorMode}-start`,
  });
}

async function waitForLayoutReady(
  app: Awaited<ReturnType<typeof createRuntime>>,
  projectId: string,
) {
  const deadline = Date.now() + 90_000;
  let projection = app.layout.workspace.project(projectId);
  while (Date.now() < deadline) {
    projection = app.layout.workspace.project(projectId);
    if (projection.workflow?.state === "ready") return projection;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const states = app.jobs.scheduler
    .list()
    .filter((job) => job.projectId === projectId)
    .reduce<Record<string, number>>((counts, job) => {
      const key = `${job.jobType}:${job.state}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
  throw new Error(
    `PRINT_FAULT_LAYOUT_TIMEOUT state=${projection.workflow?.state ?? "none"} jobs=${JSON.stringify(states)}`,
  );
}

function approvalInput(
  projection: ReturnType<
    Awaited<ReturnType<typeof createRuntime>>["layout"]["workspace"]["project"]
  >,
  owner: { customerId: string; familyId: string },
  action: "preview_sent" | "approved",
  idempotencyKey: string,
) {
  const { project, preview, approval, approvalGate, contentApproval } =
    projection;
  if (!preview || !approval || !approvalGate)
    throw new Error("PRINT_FAULT_APPROVAL_CONTEXT_MISSING");
  return {
    owner,
    projectId: project.id,
    previewOutputId: preview.id,
    cycleId: approval.id,
    action,
    idempotencyKey,
    customerContentHash: preview.customerContentHash,
    approvalBundleHash: preview.approvalBundleHash,
    expectedProjectRevision: project.revision,
    expectedPreviewOutputRevision: preview.revision,
    expectedApprovalRevision: approval.revision,
    expectedGateRevision: approvalGate.revision,
    expectedContentApprovalId: project.currentContentApprovalId,
    expectedContentApprovalRevision: contentApproval?.revision ?? null,
  };
}

async function recordAutostartFailure(
  directory: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "UNKNOWN";
  await writeFile(
    join(directory, "print-autostart.failed"),
    message.slice(0, 240),
    { encoding: "utf8", mode: 0o600 },
  );
}
