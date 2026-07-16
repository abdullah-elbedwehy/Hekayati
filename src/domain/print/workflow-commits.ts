import type { AssetStore, PreparedAsset } from "../../assets/asset-store.js";
import type { JobRecord } from "../../jobs/schemas.js";
import type { JobScheduler } from "../../jobs/scheduler.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import { hashCanonical } from "../layout/hashes.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failPrint } from "./errors.js";
import { interiorProfileHash } from "./interior-profile.js";
import { PrintRepositories } from "./repositories.js";
import type { PrintArtifact, PrintProofBundle, PrintRun } from "./schemas.js";
import type { PrintContextService } from "./workflow-context.js";
import type {
  PreparedPrintArtifactCommit,
  PreparedPrintPreflightCommit,
  PrintArtifactCommitResult,
  PrintPreflightCommitResult,
} from "./workflow-types.js";

interface ArtifactHeads {
  interior: string | null;
  cover: string | null;
}

interface PreflightContext {
  interior: PrintArtifact;
  cover: PrintArtifact;
  cmyk: boolean;
}

interface ProofCommit {
  proofBundle: PrintProofBundle;
  proofGate: JobRecord;
}

export class PrintCommitService {
  private readonly authoring: AuthoringRepositories;
  private readonly print: PrintRepositories;

  constructor(
    store: DocumentStore,
    private readonly assets: AssetStore,
    private readonly scheduler: JobScheduler,
    private readonly context: PrintContextService,
    private readonly now: () => string,
    private readonly idFactory: () => string,
  ) {
    this.authoring = new AuthoringRepositories(store);
    this.print = new PrintRepositories(store);
  }

  commitArtifact(
    job: Readonly<JobRecord>,
    prepared: PreparedPrintArtifactCommit,
  ): PrintArtifactCommitResult {
    const run = this.requireRun(prepared.runId);
    this.assertArtifactCommitFence(job, run, prepared);
    this.context.assertRunCurrent(run);
    this.assertPreparedArtifact(prepared);
    this.assertArtifactSlotEmpty(run, prepared.kind);
    const artifact = this.insertArtifact(job, run, prepared);
    const advanced = this.advanceArtifact(run, artifact);
    return { artifact, ...advanced };
  }

  commitReusedInterior(job: Readonly<JobRecord>): PrintArtifactCommitResult {
    const runId = job.inputSnapshot.runId;
    if (!runId) failPrint("PRINT_RUN_STALE");
    const run = this.requireRun(runId);
    this.context.assertRunCurrent(run);
    this.assertArtifactSlotEmpty(run, "interior");
    const source = this.requireReusableInterior(job, run);
    const artifact = this.insertReusedInterior(job, run, source);
    const advanced = this.advanceArtifact(run, artifact);
    return { artifact, ...advanced };
  }

  commitPreflight(
    job: Readonly<JobRecord>,
    prepared: PreparedPrintPreflightCommit,
  ): PrintPreflightCommitResult {
    const run = this.requireRun(prepared.runId);
    const context = this.validatePreflight(job, run, prepared);
    this.assertProofShape(prepared, context.cmyk);
    this.assertPreparedProof(prepared.proof);
    const report = this.print.preflightReports.insert(prepared.report);
    const proof = prepared.proof
      ? this.commitProof(run, job, context, prepared.proof, report.createdAt)
      : null;
    const updated = this.updatePreflightRun(
      run,
      report.id,
      report.passed,
      report.findings.map((finding) => finding.code),
      context.cmyk,
      proof,
    );
    if (updated.state === "deliverable") this.markProjectPrintReady(run);
    return {
      run: updated,
      report,
      proofBundle: proof?.proofBundle ?? null,
      proofGate: proof?.proofGate ?? null,
    };
  }

  private assertArtifactCommitFence(
    job: Readonly<JobRecord>,
    run: PrintRun,
    prepared: PreparedPrintArtifactCommit,
  ): void {
    const expectedJobId =
      prepared.kind === "interior" ? run.interiorJobId : run.coverJobId;
    if (
      job.id !== expectedJobId ||
      job.projectId !== run.projectId ||
      job.request.kind !== "local" ||
      job.inputSnapshot.runId !== run.id ||
      job.inputSnapshot.contentAuthorizationHash !==
        run.contentAuthorizationHash ||
      job.inputSnapshot.printerProfileVersionId !==
        run.printerProfileVersionId ||
      job.inputSnapshot.printerProfileHash !== run.printerProfileHash ||
      job.inputSnapshot.sourceSnapshotHash !== run.sourceSnapshotHash ||
      prepared.contentAuthorizationHash !== run.contentAuthorizationHash ||
      prepared.printerProfileVersionId !== run.printerProfileVersionId ||
      prepared.printerProfileHash !== run.printerProfileHash ||
      prepared.sourceSnapshotHash !== run.sourceSnapshotHash ||
      !["queued", "producing"].includes(run.state)
    )
      failPrint("PRINT_RUN_STALE");
  }

  private assertPreparedArtifact(prepared: PreparedPrintArtifactCommit): void {
    const integrity = this.assets.verifyPreparedIntegritySync(
      prepared.preparedAsset,
    );
    const expectedRole =
      prepared.kind === "interior" ? "pdf_interior" : "pdf_cover";
    if (
      integrity.status !== "healthy" ||
      integrity.expectedSha256 !== prepared.preparedAsset.record.sha256 ||
      prepared.preparedAsset.record.role !== expectedRole ||
      prepared.preparedAsset.record.mime !== "application/pdf" ||
      prepared.renderFactsHash !== hashCanonical(prepared.renderFacts) ||
      (prepared.kind === "cover" && prepared.renderFacts.pageCount !== 1)
    )
      failPrint("PRINT_RUN_STALE");
  }

  private assertArtifactSlotEmpty(
    run: PrintRun,
    kind: PreparedPrintArtifactCommit["kind"],
  ): void {
    const existing =
      kind === "interior"
        ? run.currentInteriorArtifactId
        : run.currentCoverArtifactId;
    if (existing) failPrint("PRINT_RUN_STALE");
  }

  private insertArtifact(
    job: Readonly<JobRecord>,
    run: PrintRun,
    prepared: PreparedPrintArtifactCommit,
  ): PrintArtifact {
    const asset = this.assets.commitPrepared(prepared.preparedAsset);
    const at = this.now();
    return this.print.artifacts.insert({
      id: this.idFactory(),
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      projectId: run.projectId,
      runId: run.id,
      jobId: job.id,
      kind: prepared.kind,
      assetId: asset.id,
      checksum: asset.sha256,
      bytes: asset.bytes,
      contentAuthorizationHash: prepared.contentAuthorizationHash,
      printerProfileVersionId: prepared.printerProfileVersionId,
      printerProfileHash: prepared.printerProfileHash,
      sourceSnapshotHash: prepared.sourceSnapshotHash,
      pageMapHash: prepared.pageMapHash,
      colorMode: prepared.colorMode,
      iccChecksum: prepared.iccChecksum,
      rendererVersion: prepared.rendererVersion,
      converterVersion: prepared.converterVersion,
      fontPolicyVersion: prepared.fontPolicyVersion,
      renderFactsHash: prepared.renderFactsHash,
      renderFacts: prepared.renderFacts,
      conversionFacts: prepared.conversionFacts,
      reusedFromArtifactId: null,
    });
  }

  private updateArtifactHeads(
    run: PrintRun,
    heads: ArtifactHeads,
    preflightJob: JobRecord | null,
  ): PrintRun {
    return this.print.runs.update(run.revision, {
      ...run,
      revision: run.revision + 1,
      updatedAt: this.now(),
      state: preflightJob ? "preflight_pending" : "producing",
      currentInteriorArtifactId: heads.interior,
      currentCoverArtifactId: heads.cover,
      preflightJobId: preflightJob?.id ?? run.preflightJobId,
    });
  }

  private advanceArtifact(
    run: PrintRun,
    artifact: PrintArtifact,
  ): { run: PrintRun; preflightJob: JobRecord | null } {
    const heads = artifactHeads(run, artifact);
    const preflightJob =
      heads.interior && heads.cover
        ? this.enqueuePreflight(run, heads.interior, heads.cover)
        : null;
    return {
      run: this.updateArtifactHeads(run, heads, preflightJob),
      preflightJob,
    };
  }

  private requireReusableInterior(
    job: Readonly<JobRecord>,
    run: PrintRun,
  ): PrintArtifact {
    const sourceId = job.inputSnapshot.reusedArtifactId;
    const sourceRunId = job.inputSnapshot.sourceRunId;
    const source = sourceId ? this.print.artifacts.get(sourceId) : null;
    const sourceRun = sourceRunId ? this.print.runs.get(sourceRunId) : null;
    const sourceVersion = sourceRun
      ? this.print.profileVersions.get(sourceRun.printerProfileVersionId)
      : null;
    const currentVersion = this.print.profileVersions.get(
      run.printerProfileVersionId,
    );
    if (!source || !sourceRun || !sourceVersion || !currentVersion)
      failPrint("PRINT_RUN_STALE");
    this.assertReuseBindings(job, run, sourceRun, source);
    const expectedHash = job.inputSnapshot.interiorProfileHash;
    if (
      interiorProfileHash(sourceVersion) !== expectedHash ||
      interiorProfileHash(currentVersion) !== expectedHash
    )
      failPrint("PRINT_RUN_STALE");
    const integrity = this.assets.verifyIntegritySync(source.assetId);
    if (
      integrity.status !== "healthy" ||
      integrity.expectedSha256 !== source.checksum
    )
      failPrint("PRINT_RUN_STALE");
    return source;
  }

  private assertReuseBindings(
    job: Readonly<JobRecord>,
    run: PrintRun,
    sourceRun: PrintRun,
    source: PrintArtifact,
  ): void {
    if (
      job.id !== run.interiorJobId ||
      job.jobType !== "print_interior_reuse" ||
      job.projectId !== run.projectId ||
      job.request.kind !== "local" ||
      !["queued", "producing"].includes(run.state) ||
      source.kind !== "interior" ||
      source.runId !== sourceRun.id ||
      sourceRun.state !== "stale" ||
      !sourceRun.staleReasons.includes("IM_15") ||
      sourceRun.currentInteriorArtifactId !== source.id ||
      job.inputSnapshot.reusedArtifactChecksum !== source.checksum ||
      sourceRun.projectId !== run.projectId ||
      sourceRun.customerId !== run.customerId ||
      sourceRun.familyId !== run.familyId ||
      sourceRun.contentAuthorizationHash !== run.contentAuthorizationHash ||
      sourceRun.compositionProfileHash !== run.compositionProfileHash ||
      sourceRun.sourceSnapshotHash !== run.sourceSnapshotHash ||
      hashCanonical(sourceRun.sourceAssets) !==
        hashCanonical(run.sourceAssets) ||
      source.contentAuthorizationHash !== run.contentAuthorizationHash ||
      source.sourceSnapshotHash !== run.sourceSnapshotHash
    )
      failPrint("PRINT_RUN_STALE");
  }

  private insertReusedInterior(
    job: Readonly<JobRecord>,
    run: PrintRun,
    source: PrintArtifact,
  ): PrintArtifact {
    const retained = this.assets.retain(source.assetId);
    if (retained.id !== source.assetId || retained.sha256 !== source.checksum)
      failPrint("PRINT_RUN_STALE");
    const at = this.now();
    return this.print.artifacts.insert({
      ...source,
      id: this.idFactory(),
      createdAt: at,
      updatedAt: at,
      projectId: run.projectId,
      runId: run.id,
      jobId: job.id,
      contentAuthorizationHash: run.contentAuthorizationHash,
      printerProfileVersionId: run.printerProfileVersionId,
      printerProfileHash: run.printerProfileHash,
      sourceSnapshotHash: run.sourceSnapshotHash,
      reusedFromArtifactId: source.id,
    });
  }

  private validatePreflight(
    job: Readonly<JobRecord>,
    run: PrintRun,
    prepared: PreparedPrintPreflightCommit,
  ): PreflightContext {
    this.assertPreflightJob(job, run);
    this.context.assertRunCurrent(run);
    const interior = run.currentInteriorArtifactId
      ? this.print.artifacts.get(run.currentInteriorArtifactId)
      : null;
    const cover = run.currentCoverArtifactId
      ? this.print.artifacts.get(run.currentCoverArtifactId)
      : null;
    if (!interior || !cover) failPrint("PRINT_RUN_STALE");
    this.assertPreflightBindings(job, run, prepared, interior, cover);
    this.assertCommittedArtifact(interior, "interior");
    this.assertCommittedArtifact(cover, "cover");
    if (interior.colorMode !== cover.colorMode) failPrint("PRINT_RUN_STALE");
    return { interior, cover, cmyk: interior.colorMode === "cmyk" };
  }

  private assertPreflightJob(job: Readonly<JobRecord>, run: PrintRun): void {
    if (
      run.state !== "preflight_pending" ||
      run.preflightJobId !== job.id ||
      job.projectId !== run.projectId ||
      job.request.kind !== "local" ||
      job.inputSnapshot.runId !== run.id ||
      job.inputSnapshot.contentAuthorizationHash !==
        run.contentAuthorizationHash ||
      job.inputSnapshot.printerProfileHash !== run.printerProfileHash
    )
      failPrint("PRINT_RUN_STALE");
  }

  private assertPreflightBindings(
    job: Readonly<JobRecord>,
    run: PrintRun,
    prepared: PreparedPrintPreflightCommit,
    interior: PrintArtifact,
    cover: PrintArtifact,
  ): void {
    const report = prepared.report;
    if (
      job.inputSnapshot.interiorArtifactId !== interior.id ||
      job.inputSnapshot.interiorChecksum !== interior.checksum ||
      job.inputSnapshot.coverArtifactId !== cover.id ||
      job.inputSnapshot.coverChecksum !== cover.checksum ||
      report.runId !== run.id ||
      report.interiorArtifactId !== interior.id ||
      report.interiorChecksum !== interior.checksum ||
      report.coverArtifactId !== cover.id ||
      report.coverChecksum !== cover.checksum ||
      report.contentAuthorizationHash !== run.contentAuthorizationHash ||
      report.printerProfileVersionId !== run.printerProfileVersionId ||
      report.printerProfileHash !== run.printerProfileHash
    )
      failPrint("PRINT_RUN_STALE");
  }

  private assertCommittedArtifact(
    artifact: PrintArtifact,
    kind: PrintArtifact["kind"],
  ): void {
    const integrity = this.assets.verifyIntegritySync(artifact.assetId);
    if (
      artifact.kind !== kind ||
      integrity.status !== "healthy" ||
      integrity.expectedSha256 !== artifact.checksum
    )
      failPrint("PRINT_RUN_STALE");
  }

  private assertProofShape(
    prepared: PreparedPrintPreflightCommit,
    cmyk: boolean,
  ): void {
    if (
      (prepared.report.passed && cmyk) !== (prepared.proof !== null) ||
      (prepared.report.passed && !cmyk && prepared.proof !== null)
    )
      failPrint("PRINT_RUN_STALE");
  }

  private assertPreparedProof(
    proof: PreparedPrintPreflightCommit["proof"],
  ): void {
    if (!proof) return;
    for (const raster of proof.rasters) {
      const integrity = this.assets.verifyPreparedIntegritySync(
        raster.prepared,
      );
      if (
        integrity.status !== "healthy" ||
        raster.prepared.record.role !== "print_proof" ||
        raster.prepared.record.mime !== "image/png"
      )
        failPrint("PRINT_RUN_STALE");
    }
  }

  private commitProof(
    run: PrintRun,
    job: Readonly<JobRecord>,
    context: PreflightContext,
    proof: NonNullable<PreparedPrintPreflightCommit["proof"]>,
    createdAt: string,
  ): ProofCommit {
    const representatives = this.commitProofRasters(proof.rasters);
    const bundleHash = hashCanonical(
      proofIdentity(run, context, representatives),
    );
    const proofGate = this.enqueueProofGate(
      run,
      job,
      proof,
      bundleHash,
      context.interior.iccChecksum!,
    );
    const proofBundle = this.print.proofBundles.insert({
      id: proof.bundleId,
      schemaVersion: 1,
      createdAt,
      updatedAt: createdAt,
      projectId: run.projectId,
      runId: run.id,
      gateJobId: proofGate.id,
      interiorArtifactId: context.interior.id,
      interiorChecksum: context.interior.checksum,
      coverArtifactId: context.cover.id,
      coverChecksum: context.cover.checksum,
      iccChecksum: context.interior.iccChecksum!,
      printerProfileHash: run.printerProfileHash,
      contentAuthorizationHash: run.contentAuthorizationHash,
      representativeAssets: representatives,
      bundleHash,
    });
    return { proofBundle, proofGate };
  }

  private commitProofRasters(
    rasters: readonly {
      kind: "interior" | "cover";
      prepared: PreparedAsset;
    }[],
  ): PrintProofBundle["representativeAssets"] {
    return rasters.map((raster) => {
      const asset = this.assets.commitPrepared(raster.prepared);
      return { kind: raster.kind, assetId: asset.id, checksum: asset.sha256 };
    });
  }

  private enqueueProofGate(
    run: PrintRun,
    job: Readonly<JobRecord>,
    proof: NonNullable<PreparedPrintPreflightCommit["proof"]>,
    bundleHash: string,
    iccChecksum: string,
  ): JobRecord {
    return this.scheduler.enqueue({
      id: proof.gateId,
      jobType: "human_gate",
      projectId: run.projectId,
      standaloneScopeId: null,
      dependsOn: [job.id],
      priority: 3,
      intentId: `print-proof-${run.id}`,
      target: null,
      request: {
        kind: "human_gate",
        gateKind: "print_converted_proof",
        targetId: run.id,
        targetVersionId: proof.bundleId,
      },
      inputSnapshot: {
        runId: run.id,
        proofBundleId: proof.bundleId,
        proofBundleHash: bundleHash,
        contentAuthorizationHash: run.contentAuthorizationHash,
        printerProfileHash: run.printerProfileHash,
        iccChecksum,
      },
    });
  }

  private updatePreflightRun(
    run: PrintRun,
    reportId: string,
    passed: boolean,
    blockingReasons: string[],
    cmyk: boolean,
    proof: ProofCommit | null,
  ): PrintRun {
    const state = passed
      ? cmyk
        ? "converted_proof_pending"
        : "deliverable"
      : "blocked";
    return this.print.runs.update(run.revision, {
      ...run,
      revision: run.revision + 1,
      updatedAt: this.now(),
      state,
      currentPreflightReportId: reportId,
      convertedProofGateJobId: proof?.proofGate.id ?? null,
      convertedProofBundleHash: proof?.proofBundle.bundleHash ?? null,
      blockingReasons,
    });
  }

  private markProjectPrintReady(run: PrintRun): void {
    const project = this.authoring.projects.get(run.projectId);
    if (!project) failPrint("PRINT_ENTITY_NOT_FOUND");
    this.authoring.projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: this.now(),
      status: "print_ready",
    });
  }

  private enqueuePreflight(
    run: PrintRun,
    interiorArtifactId: string,
    coverArtifactId: string,
  ): JobRecord {
    if (run.preflightJobId) failPrint("PRINT_RUN_STALE");
    const interior = this.print.artifacts.get(interiorArtifactId);
    const cover = this.print.artifacts.get(coverArtifactId);
    if (!interior || !cover) failPrint("PRINT_RUN_STALE");
    const id = this.idFactory();
    const payloadHash = hashCanonical({
      runId: run.id,
      interiorArtifactId,
      interiorChecksum: interior.checksum,
      coverArtifactId,
      coverChecksum: cover.checksum,
      contentAuthorizationHash: run.contentAuthorizationHash,
      printerProfileHash: run.printerProfileHash,
    });
    return this.scheduler.enqueue({
      id,
      jobType: "print_preflight",
      projectId: run.projectId,
      standaloneScopeId: null,
      dependsOn: [run.interiorJobId, run.coverJobId],
      priority: 3,
      intentId: `print-preflight-${run.id}`,
      target: null,
      request: { kind: "local", payloadHash },
      inputSnapshot: {
        runId: run.id,
        interiorArtifactId,
        interiorChecksum: interior.checksum,
        coverArtifactId,
        coverChecksum: cover.checksum,
        contentAuthorizationHash: run.contentAuthorizationHash,
        printerProfileVersionId: run.printerProfileVersionId,
        printerProfileHash: run.printerProfileHash,
      },
    });
  }

  private requireRun(id: string): PrintRun {
    const run = this.print.runs.get(id);
    if (!run) failPrint("PRINT_ENTITY_NOT_FOUND");
    return run;
  }
}

function artifactHeads(run: PrintRun, artifact: PrintArtifact): ArtifactHeads {
  return {
    interior:
      artifact.kind === "interior"
        ? artifact.id
        : run.currentInteriorArtifactId,
    cover: artifact.kind === "cover" ? artifact.id : run.currentCoverArtifactId,
  };
}

function proofIdentity(
  run: PrintRun,
  context: PreflightContext,
  representatives: PrintProofBundle["representativeAssets"],
) {
  return {
    runId: run.id,
    interiorArtifactId: context.interior.id,
    interiorChecksum: context.interior.checksum,
    coverArtifactId: context.cover.id,
    coverChecksum: context.cover.checksum,
    iccChecksum: context.interior.iccChecksum,
    printerProfileHash: run.printerProfileHash,
    contentAuthorizationHash: run.contentAuthorizationHash,
    representatives,
  };
}
