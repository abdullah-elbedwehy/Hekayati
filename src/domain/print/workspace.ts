import type { AssetStore } from "../../assets/asset-store.js";
import type { JobScheduler } from "../../jobs/scheduler.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import { checkCompositionCompatibility } from "../layout/compatibility.js";
import { LayoutRepositories } from "../layout/repositories.js";
import type { FamilyScope } from "../library/types.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failPrint } from "./errors.js";
import { PrinterProfileService } from "./profiles.js";
import { PrintRepositories } from "./repositories.js";
import type {
  PrinterProfileVersion,
  PrintArtifact,
  PrintProofBundle,
  PrintRun,
} from "./schemas.js";
import type { PrintProductionService } from "./workflow.js";

export class PrintWorkspaceService {
  private readonly print: PrintRepositories;
  private readonly authoring: AuthoringRepositories;
  private readonly layout: LayoutRepositories;
  private readonly profiles: PrinterProfileService;

  constructor(
    store: DocumentStore,
    private readonly assets: AssetStore,
    private readonly scheduler: JobScheduler,
    private readonly production: PrintProductionService,
  ) {
    this.print = new PrintRepositories(store);
    this.authoring = new AuthoringRepositories(store);
    this.layout = new LayoutRepositories(store);
    this.profiles = new PrinterProfileService(store, assets);
  }

  profilesProjection() {
    return this.profiles.list();
  }

  project(scope: FamilyScope, projectId: string) {
    const project = this.requireProject(scope, projectId);
    const profile = project.printerProfileId
      ? this.print.profiles.get(project.printerProfileId)
      : null;
    const profileVersion = profile
      ? this.print.profileVersions.get(profile.currentVersionId)
      : null;
    const { runs, run } = this.latestRun(project.id);
    const interior = this.artifact(run?.currentInteriorArtifactId ?? null);
    const cover = this.artifact(run?.currentCoverArtifactId ?? null);
    const report = run?.currentPreflightReportId
      ? this.print.preflightReports.get(run.currentPreflightReportId)
      : null;
    const proof = run ? this.proof(run) : null;
    const proofGate = run?.convertedProofGateJobId
      ? this.scheduler.get(run.convertedProofGateJobId)
      : null;
    return {
      project: {
        id: project.id,
        revision: project.revision,
        status: project.status,
        compositionProfileId: project.compositionProfileId,
        currentContentApprovalId: project.currentContentApprovalId,
        printerProfileId: project.printerProfileId,
      },
      profile,
      profileVersion,
      compatibility: profileVersion
        ? this.profileCompatibility(
            project.compositionProfileId,
            profileVersion,
          )
        : null,
      run,
      interior,
      cover,
      report,
      proof,
      proofGate: proofGateProjection(proofGate),
      history: runs.map(runHistoryProjection),
    };
  }

  private profileCompatibility(
    compositionProfileId: string,
    version: PrinterProfileVersion,
  ) {
    const composition =
      this.layout.compositionProfiles.get(compositionProfileId);
    if (!composition) failPrint("PRINT_ENTITY_NOT_FOUND");
    return checkCompositionCompatibility(composition, {
      orientation: version.trim.orientation,
      trimWidthMm: version.trim.widthMm,
      trimHeightMm: version.trim.heightMm,
      safeContentRegion: version.safeContentRegion,
      printerOnly: {
        bleedMm: version.bleedMm,
        dpi: version.dpiMin,
        color: version.color.mode,
      },
    });
  }

  private latestRun(projectId: string): {
    runs: PrintRun[];
    run: PrintRun | null;
  } {
    const runs = this.print.runs
      .queryByField("projectId", projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { runs, run: runs[0] ?? null };
  }

  async deliverable(
    scope: FamilyScope,
    runId: string,
    kind: "interior" | "cover",
  ): Promise<{ bytes: Buffer; filename: string }> {
    const run = this.requireRun(scope, runId);
    if (run.state !== "deliverable")
      failPrint("PRINT_ARTIFACT_NOT_DELIVERABLE");
    await this.production.guardRun(run.id);
    const report = run.currentPreflightReportId
      ? this.print.preflightReports.get(run.currentPreflightReportId)
      : null;
    const artifact = this.artifact(
      kind === "interior"
        ? run.currentInteriorArtifactId
        : run.currentCoverArtifactId,
    );
    if (
      !report?.passed ||
      !artifact ||
      artifact.kind !== kind ||
      artifact.runId !== run.id ||
      report.runId !== run.id ||
      report.contentAuthorizationHash !== run.contentAuthorizationHash ||
      report.printerProfileVersionId !== run.printerProfileVersionId ||
      report.printerProfileHash !== run.printerProfileHash ||
      (kind === "interior"
        ? report.interiorArtifactId !== artifact.id
        : report.coverArtifactId !== artifact.id)
    )
      failPrint("PRINT_ARTIFACT_NOT_DELIVERABLE");
    this.assertConvertedProof(run, artifact);
    this.assertIntegrity(artifact.assetId, artifact.checksum);
    return {
      bytes: await this.assets.read(artifact.assetId),
      filename: `hekayati-${run.id}-${kind}.pdf`,
    };
  }

  async proofRaster(
    scope: FamilyScope,
    runId: string,
    kind: "interior" | "cover",
  ): Promise<{ bytes: Buffer; filename: string }> {
    const run = this.requireRun(scope, runId);
    if (run.state !== "converted_proof_pending")
      failPrint("PRINT_ARTIFACT_NOT_DELIVERABLE");
    await this.production.guardRun(run.id);
    const proof = this.proof(run);
    const gate = run.convertedProofGateJobId
      ? this.scheduler.get(run.convertedProofGateJobId)
      : null;
    const raster = proof?.representativeAssets.find(
      (candidate) => candidate.kind === kind,
    );
    if (
      !proof ||
      !raster ||
      !gate ||
      gate.state !== "waiting_review" ||
      gate.request.kind !== "human_gate" ||
      gate.request.gateKind !== "print_converted_proof" ||
      gate.request.targetId !== run.id ||
      gate.request.targetVersionId !== proof.id ||
      proof.bundleHash !== run.convertedProofBundleHash
    )
      failPrint("PRINT_ARTIFACT_NOT_DELIVERABLE");
    this.assertIntegrity(raster.assetId, raster.checksum);
    return {
      bytes: await this.assets.read(raster.assetId),
      filename: `candidate-proof-${run.id}-${kind}.png`,
    };
  }

  private requireProject(scope: FamilyScope, projectId: string) {
    const project = this.authoring.projects.get(projectId);
    if (
      !project ||
      project.customerId !== scope.customerId ||
      project.familyId !== scope.familyId
    )
      failPrint("PRINT_SCOPE_REJECTED");
    return project;
  }

  private requireRun(scope: FamilyScope, runId: string): PrintRun {
    const run = this.print.runs.get(runId);
    if (!run) failPrint("PRINT_SCOPE_REJECTED");
    this.requireProject(scope, run.projectId);
    if (run.customerId !== scope.customerId || run.familyId !== scope.familyId)
      failPrint("PRINT_SCOPE_REJECTED");
    return run;
  }

  private artifact(id: string | null): PrintArtifact | null {
    return id ? this.print.artifacts.get(id) : null;
  }

  private proof(run: PrintRun): PrintProofBundle | null {
    if (!run.convertedProofBundleHash) return null;
    return (
      this.print.proofBundles
        .queryByField("runId", run.id)
        .find((bundle) => bundle.bundleHash === run.convertedProofBundleHash) ??
      null
    );
  }

  private assertConvertedProof(run: PrintRun, artifact: PrintArtifact): void {
    if (artifact.colorMode === "rgb") return;
    const proof = this.proof(run);
    const gate = run.convertedProofGateJobId
      ? this.scheduler.get(run.convertedProofGateJobId)
      : null;
    if (
      !proof ||
      !gate ||
      gate.state !== "succeeded" ||
      gate.request.kind !== "human_gate" ||
      gate.request.gateKind !== "print_converted_proof" ||
      gate.request.targetId !== run.id ||
      gate.request.targetVersionId !== proof.id ||
      proof.contentAuthorizationHash !== run.contentAuthorizationHash ||
      proof.printerProfileHash !== run.printerProfileHash ||
      proof.iccChecksum !== artifact.iccChecksum
    )
      failPrint("PRINT_ARTIFACT_NOT_DELIVERABLE");
  }

  private assertIntegrity(assetId: string, checksum: string): void {
    const integrity = this.assets.verifyIntegritySync(assetId);
    if (integrity.status !== "healthy" || integrity.expectedSha256 !== checksum)
      failPrint("PRINT_ARTIFACT_NOT_DELIVERABLE");
  }
}

function proofGateProjection(gate: ReturnType<JobScheduler["get"]>) {
  return gate
    ? { id: gate.id, revision: gate.revision, state: gate.state }
    : null;
}

function runHistoryProjection(run: PrintRun) {
  return {
    id: run.id,
    revision: run.revision,
    state: run.state,
    createdAt: run.createdAt,
    printerProfileHash: run.printerProfileHash,
    contentAuthorizationHash: run.contentAuthorizationHash,
    staleReasons: run.staleReasons,
    blockingReasons: run.blockingReasons,
  };
}
