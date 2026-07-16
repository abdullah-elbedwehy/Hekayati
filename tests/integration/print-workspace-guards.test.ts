import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";

import type {
  AssetIntegrityVerification,
  AssetStore,
} from "../../src/assets/asset-store.js";
import { PrinterProfileService } from "../../src/domain/print/profiles.js";
import { PrintRepositories } from "../../src/domain/print/repositories.js";
import {
  createDefaultPrinterProfileDraft,
  type PrintArtifact,
  type PrintPreflightReport,
  type PrintProofBundle,
  type PrintRun,
} from "../../src/domain/print/schemas.js";
import type { PrintProductionService } from "../../src/domain/print/workflow.js";
import { PrintWorkspaceService } from "../../src/domain/print/workspace.js";
import { DocumentStore as SqliteDocumentStore } from "../../src/domain/repository/document-store.js";
import { hashCanonical } from "../../src/domain/layout/hashes.js";
import type { JobScheduler } from "../../src/jobs/scheduler.js";
import { createApprovalFixture } from "../helpers/layout-approval-fixtures.js";
import { persistedPdfFactsFixture } from "../helpers/print-preflight-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-15T12:00:00.000Z";
const later = "2026-07-15T13:00:00.000Z";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const iccChecksum = hash("synthetic-cmyk-icc");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("print workspace projections and scope guards", () => {
  it("projects empty and fully-bound histories without crossing scope", async () => {
    const context = await setup();
    const empty = context.workspace.project(
      context.fixture.owner,
      context.fixture.projectId,
    );
    expect(empty).toMatchObject({
      profile: null,
      run: null,
      proof: null,
      history: [],
    });
    expect(context.workspace.profilesProjection()).toEqual([]);

    const profile = assignProfile(context);
    const older = insertGraph(context, {
      createdAt: at,
      profileBinding: profile,
    });
    const current = insertGraph(context, {
      colorMode: "cmyk",
      state: "converted_proof_pending",
      createdAt: later,
      profileBinding: profile,
    });
    const projected = context.workspace.project(
      context.fixture.owner,
      context.fixture.projectId,
    );

    expect(projected.run?.id).toBe(current.run.id);
    expect(projected.proofGate).toEqual({
      id: current.gate?.id,
      revision: current.gate?.revision,
      state: "waiting_review",
    });
    expect(projected.history.map((run) => run.id)).toEqual([
      current.run.id,
      older.run.id,
    ]);

    for (const scope of [
      { customerId: ulid(), familyId: context.fixture.owner.familyId },
      { customerId: context.fixture.owner.customerId, familyId: ulid() },
    ])
      expect(() =>
        context.workspace.project(scope, context.fixture.projectId),
      ).toThrowError("PRINT_SCOPE_REJECTED");
    expect(() =>
      context.workspace.project(context.fixture.owner, ulid()),
    ).toThrowError("PRINT_SCOPE_REJECTED");
  });

  it("rejects unknown, foreign-project, and forged run ownership", async () => {
    const context = await setup();
    await expect(
      context.workspace.deliverable(context.fixture.owner, ulid(), "interior"),
    ).rejects.toThrowError("PRINT_SCOPE_REJECTED");

    const graph = insertGraph(context);
    await expect(
      context.workspace.deliverable(
        { customerId: ulid(), familyId: context.fixture.owner.familyId },
        graph.run.id,
        "interior",
      ),
    ).rejects.toThrowError("PRINT_SCOPE_REJECTED");

    const forged = insertGraph(context, { fault: "forged_owner" });
    await expect(
      context.workspace.deliverable(
        context.fixture.owner,
        forged.run.id,
        "interior",
      ),
    ).rejects.toThrowError("PRINT_SCOPE_REJECTED");
    expect(context.guardRun).not.toHaveBeenCalled();
  });
});

describe("print deliverable guards", () => {
  const bindingCases: Array<[string, GraphOptions]> = [
    ["non-deliverable run state", { state: "preflight_pending" }],
    ["missing report", { includeReport: false }],
    ["failed report", { fault: "failed_report" }],
    ["missing artifact head", { fault: "missing_artifact" }],
    ["wrong artifact kind", { fault: "artifact_kind" }],
    ["artifact owned by another run", { fault: "artifact_run" }],
    ["report owned by another run", { fault: "report_run" }],
    ["authorization hash mismatch", { fault: "report_auth" }],
    ["profile version mismatch", { fault: "report_version" }],
    ["profile hash mismatch", { fault: "report_profile" }],
    ["report artifact binding mismatch", { fault: "report_artifact" }],
  ];

  it("blocks every stale state or report/artifact binding mismatch", async () => {
    for (const [label, options] of bindingCases) {
      const context = await setup();
      const graph = insertGraph(context, options);
      await expect(
        context.workspace.deliverable(
          context.fixture.owner,
          graph.run.id,
          "interior",
        ),
        label,
      ).rejects.toThrowError("PRINT_ARTIFACT_NOT_DELIVERABLE");
    }
  });

  it.each(["interior", "cover"] as const)(
    "returns the exact healthy RGB %s bytes and filename",
    async (kind) => {
      const context = await setup();
      const graph = insertGraph(context);
      const artifact = kind === "interior" ? graph.interior : graph.cover;

      await expect(
        context.workspace.deliverable(
          context.fixture.owner,
          graph.run.id,
          kind,
        ),
      ).resolves.toEqual({
        bytes: context.assets.bytes(artifact.assetId),
        filename: `hekayati-${graph.run.id}-${kind}.pdf`,
      });
      expect(context.guardRun).toHaveBeenCalledWith(graph.run.id);
    },
  );

  it("requires an exact approved CMYK proof and healthy artifact bytes", async () => {
    // prettier-ignore
    const cases: Array<[string, GraphOptions]> = [
      ["missing proof", { includeProof: false }],
      ["missing gate", { includeGate: false }],
      ["gate not approved", { gate: { state: "waiting_review" } }],
      ["non-human gate", { gate: { state: "succeeded", requestKind: "local" } }],
      ["wrong gate kind", { gate: { state: "succeeded", gateKind: "customer_approval" } }],
      ["wrong gate target", { gate: { state: "succeeded", targetId: ulid() } }],
      ["wrong proof target", { gate: { state: "succeeded", targetVersionId: ulid() } }],
      ["proof authorization mismatch", { fault: "proof_auth" }],
      ["proof profile mismatch", { fault: "proof_profile" }],
      ["proof ICC mismatch", { fault: "proof_icc" }],
    ];
    for (const [label, options] of cases) {
      const context = await setup();
      const graph = insertGraph(context, {
        colorMode: "cmyk",
        ...options,
      });
      await expect(
        context.workspace.deliverable(
          context.fixture.owner,
          graph.run.id,
          "interior",
        ),
        label,
      ).rejects.toThrowError("PRINT_ARTIFACT_NOT_DELIVERABLE");
    }

    const corrupt = await setup();
    const corruptGraph = insertGraph(corrupt, { colorMode: "cmyk" });
    corrupt.assets.setIntegrity(corruptGraph.interior.assetId, "corrupt");
    await expect(
      corrupt.workspace.deliverable(
        corrupt.fixture.owner,
        corruptGraph.run.id,
        "interior",
      ),
    ).rejects.toThrowError("PRINT_ARTIFACT_NOT_DELIVERABLE");

    const context = await setup();
    const graph = insertGraph(context, { colorMode: "cmyk" });
    await expect(
      context.workspace.deliverable(
        context.fixture.owner,
        graph.run.id,
        "interior",
      ),
    ).resolves.toMatchObject({
      bytes: context.assets.bytes(graph.interior.assetId),
    });
  });
});

describe("converted proof raster guards", () => {
  it("blocks every state, gate, proof, and integrity mismatch", async () => {
    // prettier-ignore
    const cases: Array<[string, GraphOptions, ("invalid" | "missing" | "corrupt")?]> = [
      ["wrong run state", { state: "deliverable" }],
      ["missing proof", { includeProof: false }],
      ["missing representative raster", {}, "invalid"],
      ["missing gate", { includeGate: false }],
      ["gate already completed", { gate: { state: "succeeded" } }],
      ["non-human gate", { gate: { state: "waiting_review", requestKind: "local" } }],
      ["wrong gate kind", { gate: { state: "waiting_review", gateKind: "customer_approval" } }],
      ["wrong run target", { gate: { state: "waiting_review", targetId: ulid() } }],
      ["wrong proof target", { gate: { state: "waiting_review", targetVersionId: ulid() } }],
      ["missing raster bytes", {}, "missing"],
      ["corrupt raster bytes", {}, "corrupt"],
    ];

    for (const [label, options, fault] of cases) {
      const context = await setup();
      const graph = insertGraph(context, {
        colorMode: "cmyk",
        state: "converted_proof_pending",
        ...options,
      });
      const kind = fault === "invalid" ? ("spine" as never) : "interior";
      if (fault === "missing" || fault === "corrupt")
        context.assets.setIntegrity(
          graph.proof!.representativeAssets[0].assetId,
          fault,
        );
      await expect(
        context.workspace.proofRaster(
          context.fixture.owner,
          graph.run.id,
          kind,
        ),
        label,
      ).rejects.toThrowError("PRINT_ARTIFACT_NOT_DELIVERABLE");
    }
  });

  it.each(["interior", "cover"] as const)(
    "returns the exact healthy %s proof raster",
    async (kind) => {
      const context = await setup();
      const graph = insertGraph(context, {
        colorMode: "cmyk",
        state: "converted_proof_pending",
      });
      const raster = graph.proof!.representativeAssets.find(
        (candidate) => candidate.kind === kind,
      )!;

      await expect(
        context.workspace.proofRaster(
          context.fixture.owner,
          graph.run.id,
          kind,
        ),
      ).resolves.toEqual({
        bytes: context.assets.bytes(raster.assetId),
        filename: `candidate-proof-${graph.run.id}-${kind}.png`,
      });
    },
  );
});

// prettier-ignore
type GateRecord = { id: string; revision: number; state: "waiting_review" | "succeeded"; request: { kind: "local"; payloadHash: string } | { kind: "human_gate"; gateKind: string; targetId: string; targetVersionId: string } };
// prettier-ignore
type GateOptions = { state?: GateRecord["state"]; requestKind?: GateRecord["request"]["kind"]; gateKind?: string; targetId?: string; targetVersionId?: string };

interface GraphOptions {
  colorMode?: "rgb" | "cmyk";
  state?: PrintRun["state"];
  createdAt?: string;
  includeReport?: boolean;
  includeProof?: boolean;
  includeGate?: boolean;
  gate?: GateOptions;
  profileBinding?: ReturnType<PrinterProfileService["create"]>;
  fault?: GraphFault;
}

// prettier-ignore
type GraphFault = "forged_owner" | "failed_report" | "missing_artifact" | "artifact_kind" | "artifact_run" | "report_run" | "report_auth" | "report_version" | "report_profile" | "report_artifact" | "proof_auth" | "proof_profile" | "proof_icc";

interface GraphDrafts {
  run: PrintRun;
  interior: PrintArtifact;
  cover: PrintArtifact;
  report: PrintPreflightReport | null;
  proof: PrintProofBundle | null;
  gate: GateRecord | null;
}

async function setup() {
  const directory = await temporaryDirectory("hekayati-print-workspace-");
  const store = new SqliteDocumentStore(join(directory.path, "hekayati.db"));
  cleanups.push(async () => {
    store.close();
    await directory.cleanup();
  });
  const fixture = createApprovalFixture(store);
  const assets = fakeAssets();
  const gates = new Map<string, GateRecord>();
  const scheduler = {
    get: vi.fn((id: string) => gates.get(id) ?? null),
  } as unknown as JobScheduler;
  const guardRun = vi.fn(async (runId: string) => ({ runId }));
  const production = { guardRun } as unknown as PrintProductionService;
  return {
    store,
    fixture,
    assets,
    gates,
    guardRun,
    workspace: new PrintWorkspaceService(
      store,
      assets.port,
      scheduler,
      production,
    ),
    print: new PrintRepositories(store),
  };
}

type Context = Awaited<ReturnType<typeof setup>>;

function assignProfile(context: Context) {
  const service = new PrinterProfileService(
    context.store,
    context.assets.port,
    {
      now: () => at,
    },
  );
  const profile = service.create({
    name: "Synthetic workspace profile",
    draft: {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit", widthMm: 8 },
    },
  });
  const project = context.fixture.authoring.projects.get(
    context.fixture.projectId,
  )!;
  service.assignProject({
    owner: context.fixture.owner,
    projectId: project.id,
    expectedProjectRevision: project.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
  });
  return profile;
}

function insertGraph(
  context: Context,
  options: GraphOptions = {},
): GraphDrafts {
  const colorMode = options.colorMode ?? "rgb";
  const createdAt = options.createdAt ?? at;
  const runId = ulid();
  const profileId = options.profileBinding?.profile.id ?? ulid();
  const profileVersionId = options.profileBinding?.version.id ?? ulid();
  const profileHash =
    options.profileBinding?.version.profileHash ?? hash(`profile-${runId}`);
  const authorizationHash = hash(`authorization-${runId}`);
  const sourceSnapshotHash = hash(`snapshot-${runId}`);
  const interiorFile = context.assets.add(`interior-${runId}.pdf`);
  const coverFile = context.assets.add(`cover-${runId}.pdf`);
  const interior = artifact({
    id: ulid(),
    runId,
    projectId: context.fixture.projectId,
    jobId: ulid(),
    kind: "interior",
    file: interiorFile,
    colorMode,
    authorizationHash,
    profileVersionId,
    profileHash,
    sourceSnapshotHash,
    createdAt,
  });
  const cover = artifact({
    id: ulid(),
    runId,
    projectId: context.fixture.projectId,
    jobId: ulid(),
    kind: "cover",
    file: coverFile,
    colorMode,
    authorizationHash,
    profileVersionId,
    profileHash,
    sourceSnapshotHash,
    createdAt,
  });
  const report =
    options.includeReport === false
      ? null
      : preflightReport({
          runId,
          projectId: context.fixture.projectId,
          interior,
          cover,
          colorMode,
          authorizationHash,
          profileVersionId,
          profileHash,
          createdAt,
        });
  const includeProof = options.includeProof ?? colorMode === "cmyk";
  const proof = includeProof
    ? proofBundle(context, {
        runId,
        projectId: context.fixture.projectId,
        interior,
        cover,
        authorizationHash,
        profileHash,
        createdAt,
      })
    : null;
  const includeGate = options.includeGate ?? colorMode === "cmyk";
  const defaultGateState =
    options.state === "converted_proof_pending"
      ? "waiting_review"
      : "succeeded";
  const gate = includeGate
    ? gateRecord(runId, proof?.id ?? ulid(), options.gate, defaultGateState)
    : null;
  const project = context.fixture.authoring.projects.get(
    context.fixture.projectId,
  )!;
  const run: PrintRun = {
    id: runId,
    schemaVersion: 1,
    createdAt,
    updatedAt: createdAt,
    revision: 0,
    projectId: project.id,
    familyId: project.familyId,
    customerId: project.customerId,
    requestHash: hash(`request-${runId}`),
    idempotencyKey: `workspace-${runId}`,
    contentAuthorizationHash: authorizationHash,
    approvalCycleId: ulid(),
    approvalGateJobId: ulid(),
    previewOutputId: ulid(),
    customerContentHash: hash(`content-${runId}`),
    compositionProfileId: project.compositionProfileId,
    compositionProfileHash: hash(`composition-${runId}`),
    printerProfileId: profileId,
    printerProfileVersionId: profileVersionId,
    printerProfileHash: profileHash,
    sourceSnapshotHash,
    sourceAssets: [],
    state: options.state ?? "deliverable",
    interiorJobId: interior.jobId,
    coverJobId: cover.jobId,
    preflightJobId: report ? ulid() : null,
    convertedProofGateJobId: gate?.id ?? null,
    currentInteriorArtifactId: interior.id,
    currentCoverArtifactId: cover.id,
    currentPreflightReportId: report?.id ?? null,
    convertedProofBundleHash: proof?.bundleHash ?? null,
    blockingReasons: [],
    staleReasons: [],
    invalidatedByEventIds: [],
  };
  const drafts = { run, interior, cover, report, proof, gate };
  applyFault(drafts, options.fault);
  context.print.artifacts.insert(interior);
  context.print.artifacts.insert(cover);
  if (report) context.print.preflightReports.insert(report);
  if (proof) context.print.proofBundles.insert(proof);
  context.print.runs.insert(run);
  if (gate) context.gates.set(gate.id, gate);
  return drafts;
}

function applyFault(drafts: GraphDrafts, fault?: GraphFault): void {
  const { run, interior, cover, report, proof } = drafts;
  if (fault === "forged_owner") run.customerId = ulid();
  if (fault === "failed_report") {
    report!.findings = [
      {
        code: "SYNTHETIC_BLOCK",
        artifact: "bundle",
        page: null,
        severity: "blocking",
        expected: true,
        actual: false,
      },
    ];
    report!.passed = false;
  }
  if (fault === "missing_artifact") run.currentInteriorArtifactId = null;
  if (fault === "artifact_kind") run.currentInteriorArtifactId = cover.id;
  if (fault === "artifact_run") interior.runId = ulid();
  if (fault === "report_run") report!.runId = ulid();
  if (fault === "report_auth")
    report!.contentAuthorizationHash = hash("other-authorization");
  if (fault === "report_version") report!.printerProfileVersionId = ulid();
  if (fault === "report_profile")
    report!.printerProfileHash = hash("other-profile");
  if (fault === "report_artifact") report!.interiorArtifactId = ulid();
  if (fault === "proof_auth")
    proof!.contentAuthorizationHash = hash("proof-auth-mismatch");
  if (fault === "proof_profile")
    proof!.printerProfileHash = hash("proof-profile-mismatch");
  if (fault === "proof_icc") proof!.iccChecksum = hash("proof-icc-mismatch");
}

// prettier-ignore
type ArtifactInput = { id: string; runId: string; projectId: string; jobId: string; kind: "interior" | "cover"; file: FakeFile; colorMode: "rgb" | "cmyk"; authorizationHash: string; profileVersionId: string; profileHash: string; sourceSnapshotHash: string; createdAt: string };

function artifact(input: ArtifactInput): PrintArtifact {
  const panelOrder: ["back", "spine", "front"] | null =
    input.kind === "cover" ? ["back", "spine", "front"] : null;
  const renderFacts = {
    pageCount: input.kind === "cover" ? 1 : 16,
    egressRequestCount: 0 as const,
    overflowPageNumbers: [],
    watermarkCount: 0 as const,
    minimumImagePpi: 300,
    fontNames: ["IBM Plex Sans Arabic"],
    panelOrder,
  };
  return {
    id: input.id,
    schemaVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    projectId: input.projectId,
    runId: input.runId,
    jobId: input.jobId,
    kind: input.kind,
    assetId: input.file.id,
    checksum: input.file.checksum,
    bytes: input.file.bytes.byteLength,
    contentAuthorizationHash: input.authorizationHash,
    printerProfileVersionId: input.profileVersionId,
    printerProfileHash: input.profileHash,
    sourceSnapshotHash: input.sourceSnapshotHash,
    pageMapHash: hash(`page-map-${input.id}`),
    colorMode: input.colorMode,
    iccChecksum: input.colorMode === "cmyk" ? iccChecksum : null,
    rendererVersion: "hekayati.print.chromium.v1",
    converterVersion:
      input.colorMode === "cmyk" ? "ghostscript.synthetic.v1" : null,
    fontPolicyVersion: "hekayati.print-fonts.v1",
    renderFactsHash: hashCanonical(renderFacts),
    renderFacts,
    conversionFacts:
      input.colorMode === "cmyk"
        ? {
            outputConditionIdentifier: "Synthetic CMYK",
            embeddedIccChecksum: iccChecksum,
            embeddedIccBytes: 128,
            imageCount: 1,
            contentStreamCount: 1,
            cmykOnly: true,
            outputIntentMatches: true,
            geometryPreserved: true,
            fontsPreserved: true,
          }
        : null,
    reusedFromArtifactId: null,
  };
}

// prettier-ignore
type ReportInput = { runId: string; projectId: string; interior: PrintArtifact; cover: PrintArtifact; colorMode: "rgb" | "cmyk"; authorizationHash: string; profileVersionId: string; profileHash: string; createdAt: string };

function preflightReport(input: ReportInput): PrintPreflightReport {
  const measurements = {
    pageMap: [],
    interior: persistedPdfFactsFixture(16),
    cover: persistedPdfFactsFixture(1),
    sourceAssets: [],
    outputChecksums: {
      interior: input.interior.checksum,
      cover: input.cover.checksum,
    },
    coverSpread: {
      panelOrder: ["back", "spine", "front"] as ["back", "spine", "front"],
      spineWidthMm: 8,
      panels: [
        { kind: "back" as const, boxMm: box(3, 210) },
        { kind: "spine" as const, boxMm: box(213, 8) },
        { kind: "front" as const, boxMm: box(221, 210) },
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
    colorMode: input.colorMode,
    iccChecksum: input.colorMode === "cmyk" ? iccChecksum : null,
    outputIntentMatches: true,
  };
  return {
    id: ulid(),
    schemaVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    projectId: input.projectId,
    runId: input.runId,
    interiorArtifactId: input.interior.id,
    interiorChecksum: input.interior.checksum,
    coverArtifactId: input.cover.id,
    coverChecksum: input.cover.checksum,
    contentAuthorizationHash: input.authorizationHash,
    printerProfileVersionId: input.profileVersionId,
    printerProfileHash: input.profileHash,
    policyVersion: "hekayati.print-preflight.v1",
    toolVersions: { qpdf: "synthetic" },
    findings: [],
    measurements,
    measurementsHash: hashCanonical(measurements),
    passed: true,
  };
}

// prettier-ignore
type ProofInput = { runId: string; projectId: string; interior: PrintArtifact; cover: PrintArtifact; authorizationHash: string; profileHash: string; createdAt: string };

function proofBundle(context: Context, input: ProofInput): PrintProofBundle {
  const interiorRaster = context.assets.add(
    `proof-${input.runId}-interior.png`,
  );
  const coverRaster = context.assets.add(`proof-${input.runId}-cover.png`);
  return {
    id: ulid(),
    schemaVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    projectId: input.projectId,
    runId: input.runId,
    gateJobId: ulid(),
    interiorArtifactId: input.interior.id,
    interiorChecksum: input.interior.checksum,
    coverArtifactId: input.cover.id,
    coverChecksum: input.cover.checksum,
    iccChecksum,
    printerProfileHash: input.profileHash,
    contentAuthorizationHash: input.authorizationHash,
    representativeAssets: [
      {
        kind: "interior",
        assetId: interiorRaster.id,
        checksum: interiorRaster.checksum,
      },
      {
        kind: "cover",
        assetId: coverRaster.id,
        checksum: coverRaster.checksum,
      },
    ],
    bundleHash: hash(`proof-bundle-${input.runId}`),
  };
}

function gateRecord(
  runId: string,
  proofId: string,
  options: GateOptions = {},
  defaultState: GateRecord["state"],
): GateRecord {
  const id = ulid();
  const request =
    options.requestKind === "local"
      ? ({ kind: "local", payloadHash: hash(`local-gate-${id}`) } as const)
      : ({
          kind: "human_gate",
          gateKind: options.gateKind ?? "print_converted_proof",
          targetId: options.targetId ?? runId,
          targetVersionId: options.targetVersionId ?? proofId,
        } as const);
  return {
    id,
    revision: 3,
    state: options.state ?? defaultState,
    request,
  };
}

function fakeAssets() {
  const files = new Map<
    string,
    FakeFile & { status: "healthy" | "missing" | "corrupt" }
  >();
  const port = {
    get: vi.fn(() => null),
    read: vi.fn(async (id: string) => Buffer.from(requireFile(id).bytes)),
    verifyIntegritySync: vi.fn((id: string): AssetIntegrityVerification => {
      const file = requireFile(id);
      if (file.status === "healthy")
        return {
          assetId: id,
          expectedSha256: file.checksum,
          status: "healthy",
          reason: null,
        };
      if (file.status === "missing")
        return {
          assetId: id,
          expectedSha256: file.checksum,
          status: "missing",
          reason: "missing",
        };
      return {
        assetId: id,
        expectedSha256: file.checksum,
        status: "corrupt",
        reason: "checksum_mismatch",
      };
    }),
  } as unknown as AssetStore;
  function requireFile(id: string) {
    const file = files.get(id);
    if (!file) throw new Error("SYNTHETIC_ASSET_NOT_FOUND");
    return file;
  }
  return {
    port,
    add(label: string): FakeFile {
      const bytes = Buffer.from(`synthetic:${label}`);
      const file = { id: ulid(), bytes, checksum: hash(bytes.toString()) };
      files.set(file.id, { ...file, status: "healthy" });
      return file;
    },
    bytes(id: string) {
      return Buffer.from(requireFile(id).bytes);
    },
    setIntegrity(id: string, status: "missing" | "corrupt") {
      requireFile(id).status = status;
    },
  };
}

interface FakeFile {
  id: string;
  bytes: Buffer;
  checksum: string;
}

function box(x: number, width: number) {
  return { x, y: 3, width, height: 297 };
}
