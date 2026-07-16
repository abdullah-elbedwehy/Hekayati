import type { AssetStore } from "../../../src/assets/asset-store.js";
import { AuthoringRepositories } from "../../../src/domain/authoring/repositories.js";
import { hashCanonical } from "../../../src/domain/layout/hashes.js";
import { PrinterProfileService } from "../../../src/domain/print/profiles.js";
import { PrintRepositories } from "../../../src/domain/print/repositories.js";
import { createDefaultPrinterProfileDraft } from "../../../src/domain/print/schemas.js";
import type { DocumentStore } from "../../../src/domain/repository/document-store.js";
import type { JobScheduler } from "../../../src/jobs/scheduler.js";
import { validTestIcc } from "../icc-profile.js";
import { persistedPdfFactsFixture } from "../print-preflight-fixtures.js";
import type { seedLayoutAndApproval } from "./layout.js";
import {
  hash,
  portabilityFixtureAt,
  succeedLocalJob,
  syntheticPdf,
  waitingGate,
  type PortabilityFixtureScope,
} from "./support.js";

export async function seedPrintEvidence(input: {
  store: DocumentStore;
  assets: AssetStore;
  scheduler: JobScheduler;
  scope: PortabilityFixtureScope;
  layout: Awaited<ReturnType<typeof seedLayoutAndApproval>>;
  repeatedAssetId: string;
  nextId: () => string;
}) {
  const authoring = new AuthoringRepositories(input.store);
  const icc = await input.assets.put({
    bytes: validTestIcc("CMYK"),
    extension: "icc",
    mime: "application/vnd.iccprofile",
    role: "icc_profile",
    origin: "upload",
  });
  const template = await input.assets.put({
    bytes: syntheticPdf("printer-template"),
    extension: "pdf",
    mime: "application/pdf",
    role: "printer_template",
    origin: "upload",
  });
  const width = 428;
  const profiles = new PrinterProfileService(input.store, input.assets, {
    now: () => portabilityFixtureAt,
    idFactory: input.nextId,
  });
  const profile = profiles.create({
    name: "ملف نقل CMYK اصطناعي",
    draft: {
      ...createDefaultPrinterProfileDraft(),
      color: {
        mode: "cmyk",
        iccAssetId: icc.id,
        iccChecksum: icc.sha256,
      },
      spine: { source: "explicit", widthMm: 8 },
      coverTemplate: {
        assetId: template.id,
        checksum: template.sha256,
        pageWidthMm: width,
        pageHeightMm: 297,
        backRegion: { x: 0, y: 0, width: 210 / width, height: 1 },
        spineRegion: { x: 210 / width, y: 0, width: 8 / width, height: 1 },
        frontRegion: { x: 218 / width, y: 0, width: 210 / width, height: 1 },
        toleranceMm: 0.5,
      },
    },
  });
  const project = authoring.projects.get(input.scope.projectId)!;
  profiles.assignProject({
    owner: {
      customerId: input.scope.customerId,
      familyId: input.scope.familyId,
    },
    projectId: project.id,
    expectedProjectRevision: project.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
  });
  const runId = input.nextId();
  const interiorJob = succeedLocalJob(input.scheduler, {
    jobType: "print_interior",
    projectId: input.scope.projectId,
    intentId: "print-interior",
    resultRefs: [],
  });
  const coverJob = succeedLocalJob(input.scheduler, {
    jobType: "print_cover",
    projectId: input.scope.projectId,
    intentId: "print-cover",
    resultRefs: [],
  });
  const preflightJob = succeedLocalJob(input.scheduler, {
    jobType: "print_preflight",
    projectId: input.scope.projectId,
    intentId: "print-preflight",
    dependsOn: [interiorJob.id, coverJob.id],
    resultRefs: [],
  });
  const proofBundleId = input.nextId();
  const proofGate = waitingGate(input.scheduler, {
    jobType: "print_converted_proof_gate",
    gateKind: "print_converted_proof",
    projectId: input.scope.projectId,
    targetId: runId,
    targetVersionId: proofBundleId,
    intentId: "print-proof",
    dependsOn: [preflightJob.id],
  });
  const completedGate = input.scheduler.completeHumanGate(
    proofGate.id,
    {
      expectedRevision: proofGate.revision,
      targetVersionId: proofBundleId,
    },
    () => true,
  );
  const interiorAsset = await input.assets.put({
    bytes: syntheticPdf("interior"),
    extension: "pdf",
    mime: "application/pdf",
    role: "pdf_interior",
    origin: "derived",
  });
  const coverAsset = await input.assets.put({
    bytes: syntheticPdf("cover"),
    extension: "pdf",
    mime: "application/pdf",
    role: "pdf_cover",
    origin: "derived",
  });
  const print = new PrintRepositories(input.store);
  const authorizationHash = hash("content-authorization");
  const sourceSnapshotHash = hash("print-source");
  const artifactBase = {
    schemaVersion: 1 as const,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    projectId: input.scope.projectId,
    runId,
    contentAuthorizationHash: authorizationHash,
    printerProfileVersionId: profile.version.id,
    printerProfileHash: profile.version.profileHash,
    sourceSnapshotHash,
    pageMapHash: hash("page-map"),
    colorMode: "cmyk" as const,
    iccChecksum: icc.sha256,
    rendererVersion: "hekayati.print.chromium.v1",
    converterVersion: "ghostscript.fixture.v1",
    fontPolicyVersion: "hekayati.print-fonts.v1",
    conversionFacts: {
      outputConditionIdentifier: "Synthetic CMYK",
      embeddedIccChecksum: icc.sha256,
      embeddedIccBytes: icc.bytes,
      imageCount: 1,
      contentStreamCount: 1,
      cmykOnly: true as const,
      outputIntentMatches: true as const,
      geometryPreserved: true as const,
      fontsPreserved: true as const,
    },
    reusedFromArtifactId: null,
  };
  const interiorFacts = renderFacts(16, null);
  const interior = print.artifacts.insert({
    ...artifactBase,
    id: input.nextId(),
    jobId: interiorJob.id,
    kind: "interior",
    assetId: interiorAsset.id,
    checksum: interiorAsset.sha256,
    bytes: interiorAsset.bytes,
    renderFactsHash: hashCanonical(interiorFacts),
    renderFacts: interiorFacts,
  });
  const coverFacts = renderFacts(1, ["back", "spine", "front"]);
  const cover = print.artifacts.insert({
    ...artifactBase,
    id: input.nextId(),
    jobId: coverJob.id,
    kind: "cover",
    assetId: coverAsset.id,
    checksum: coverAsset.sha256,
    bytes: coverAsset.bytes,
    renderFactsHash: hashCanonical(coverFacts),
    renderFacts: coverFacts,
  });
  const repeated = input.assets.get(input.repeatedAssetId)!;
  const measurements = printMeasurements({
    repeatedAssetId: input.repeatedAssetId,
    repeatedChecksum: repeated.sha256,
    interiorChecksum: interior.checksum,
    coverChecksum: cover.checksum,
    iccChecksum: icc.sha256,
  });
  const report = print.preflightReports.insert({
    id: input.nextId(),
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    projectId: input.scope.projectId,
    runId,
    interiorArtifactId: interior.id,
    interiorChecksum: interior.checksum,
    coverArtifactId: cover.id,
    coverChecksum: cover.checksum,
    contentAuthorizationHash: authorizationHash,
    printerProfileVersionId: profile.version.id,
    printerProfileHash: profile.version.profileHash,
    policyVersion: "hekayati.print-preflight.v1",
    toolVersions: { qpdf: "fixture", poppler: "fixture" },
    findings: [],
    measurements,
    measurementsHash: hashCanonical(measurements),
    passed: true,
  });
  const bundleHash = hash("proof-bundle");
  print.proofBundles.insert({
    id: proofBundleId,
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    projectId: input.scope.projectId,
    runId,
    gateJobId: proofGate.id,
    interiorArtifactId: interior.id,
    interiorChecksum: interior.checksum,
    coverArtifactId: cover.id,
    coverChecksum: cover.checksum,
    iccChecksum: icc.sha256,
    printerProfileHash: profile.version.profileHash,
    contentAuthorizationHash: authorizationHash,
    representativeAssets: [
      {
        kind: "interior",
        assetId: interiorAsset.id,
        checksum: interiorAsset.sha256,
      },
      {
        kind: "cover",
        assetId: coverAsset.id,
        checksum: coverAsset.sha256,
      },
    ],
    bundleHash,
  });
  print.proofActions.insert({
    id: input.nextId(),
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    runId,
    gateJobId: proofGate.id,
    ownerCustomerId: input.scope.customerId,
    ownerFamilyId: input.scope.familyId,
    action: "approved",
    idempotencyKey: "portability-proof-approved",
    canonicalRequestHash: hash("proof-action"),
    expectedRunRevision: 0,
    expectedGateRevision: proofGate.revision,
    proofBundleHash: bundleHash,
    contentAuthorizationHash: authorizationHash,
    printerProfileHash: profile.version.profileHash,
    iccChecksum: icc.sha256,
    normalizedNotes: "",
    resultRunRevision: 0,
    resultGateRevision: completedGate.revision,
    recordedAt: portabilityFixtureAt,
  });
  print.runs.insert({
    id: runId,
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    revision: 0,
    projectId: input.scope.projectId,
    familyId: input.scope.familyId,
    customerId: input.scope.customerId,
    requestHash: hash("print-request"),
    idempotencyKey: "portability-print-run",
    contentAuthorizationHash: authorizationHash,
    approvalCycleId: input.layout.cycleId,
    approvalGateJobId: input.layout.gateId,
    previewOutputId: input.layout.output.id,
    customerContentHash: input.layout.output.customerContentHash,
    compositionProfileId: input.layout.profile.id,
    compositionProfileHash: input.layout.profile.hash,
    printerProfileId: profile.profile.id,
    printerProfileVersionId: profile.version.id,
    printerProfileHash: profile.version.profileHash,
    sourceSnapshotHash,
    sourceAssets: [
      {
        role: "illustration",
        assetId: input.repeatedAssetId,
        checksum: repeated.sha256,
      },
    ],
    state: "deliverable",
    interiorJobId: interiorJob.id,
    coverJobId: coverJob.id,
    preflightJobId: preflightJob.id,
    convertedProofGateJobId: proofGate.id,
    currentInteriorArtifactId: interior.id,
    currentCoverArtifactId: cover.id,
    currentPreflightReportId: report.id,
    convertedProofBundleHash: bundleHash,
    blockingReasons: [],
    staleReasons: [],
    invalidatedByEventIds: [],
  });
  const assigned = authoring.projects.get(input.scope.projectId)!;
  authoring.projects.update({
    ...assigned,
    revision: assigned.revision + 1,
    updatedAt: portabilityFixtureAt,
    status: "print_ready",
  });
  return { runId };
}

function renderFacts(
  pageCount: number,
  panelOrder: ["back", "spine", "front"] | null,
) {
  return {
    pageCount,
    egressRequestCount: 0 as const,
    overflowPageNumbers: [],
    watermarkCount: 0 as const,
    minimumImagePpi: 300,
    fontNames: ["IBM Plex Sans Arabic"],
    panelOrder,
  };
}

function printMeasurements(input: {
  repeatedAssetId: string;
  repeatedChecksum: string;
  interiorChecksum: string;
  coverChecksum: string;
  iccChecksum: string;
}) {
  return {
    pageMap: [],
    interior: persistedPdfFactsFixture(16),
    cover: persistedPdfFactsFixture(1),
    sourceAssets: [
      {
        role: "illustration",
        assetId: input.repeatedAssetId,
        checksum: input.repeatedChecksum,
      },
    ],
    outputChecksums: {
      interior: input.interiorChecksum,
      cover: input.coverChecksum,
    },
    coverSpread: {
      panelOrder: ["back", "spine", "front"] as ["back", "spine", "front"],
      spineWidthMm: 8,
      panels: [
        {
          kind: "back" as const,
          boxMm: { x: 3, y: 3, width: 210, height: 297 },
        },
        {
          kind: "spine" as const,
          boxMm: { x: 213, y: 3, width: 8, height: 297 },
        },
        {
          kind: "front" as const,
          boxMm: { x: 221, y: 3, width: 210, height: 297 },
        },
      ],
      foldLinesMm: [213, 221] as [number, number],
    },
    cropMarks: {
      enabled: false,
      offsetMm: 0,
      lengthMm: 0,
      strokePt: 0.25,
      interiorSegmentCount: 0,
      coverSegmentCount: 0,
    },
    colorMode: "cmyk" as const,
    iccChecksum: input.iccChecksum,
    outputIntentMatches: true,
  };
}
