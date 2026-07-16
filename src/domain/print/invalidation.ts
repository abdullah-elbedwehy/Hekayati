import type { AssetStore } from "../../assets/asset-store.js";
import type { JobRecord } from "../../jobs/schemas.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type {
  InvalidationParticipant,
  ResolvedArtifact,
} from "../creative/invalidation-support.js";
import type { InvalidationConsequence } from "../creative/invalidation-rules.js";
import { CreativeRepositories } from "../creative/repositories.js";
import type { ChangeEvent } from "../library/schemas.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failPrint } from "./errors.js";
import { PrintRepositories } from "./repositories.js";
import type {
  PrintArtifact,
  PrintPreflightReport,
  PrintProofBundle,
  PrintRun,
} from "./schemas.js";

export interface PrintInvalidationGateController {
  get(id: string): JobRecord | null;
  cancel(
    id: string,
    input: {
      expectedRevision: number;
      expectedState: JobRecord["state"];
    },
  ): JobRecord;
  cancelOwnedHumanGate(
    id: string,
    input: {
      expectedRevision: number;
      targetVersionId: string;
      reason: string;
    },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord;
  pauseOwnedForIntegrity(
    id: string,
    input: { expectedRevision: number },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord;
  releaseOwnedIntegrityPause(
    id: string,
    input: { expectedRevision: number },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord;
}

const printKinds = new Set([
  "print_interior",
  "print_cover",
  "print_preflight",
  "print_proof",
  "print_run",
]);
const terminalJobStates = new Set<JobRecord["state"]>([
  "succeeded",
  "failed",
  "canceled",
]);

export class PrintInvalidationParticipant implements InvalidationParticipant {
  private readonly print: PrintRepositories;
  private readonly authoring: AuthoringRepositories;
  private readonly creative: CreativeRepositories;

  constructor(
    private readonly store: DocumentStore,
    private readonly assets: AssetStore,
    private readonly gates: PrintInvalidationGateController,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.print = new PrintRepositories(store);
    this.authoring = new AuthoringRepositories(store);
    this.creative = new CreativeRepositories(store);
  }

  resolve(event: ChangeEvent): ResolvedArtifact[] {
    const projectIds = this.sourceProjectIds(event);
    const runs = this.print.runs
      .list()
      .filter(
        (run) =>
          projectIds.includes(run.projectId) &&
          (event.entity !== "asset_integrity" ||
            this.referencesAsset(run, event.entityId)) &&
          !["stale", "rejected"].includes(run.state),
      );
    return runs.flatMap((run) => this.resolveRun(run));
  }

  sourceProjectIds(event: ChangeEvent): string[] {
    if (event.entity === "asset_integrity")
      return unique(
        this.print.runs
          .list()
          .filter((run) => this.referencesAsset(run, event.entityId))
          .map((run) => run.projectId),
      );
    const project = this.authoring.projects.get(event.entityId);
    if (project) return [project.id];
    const override = this.authoring.projectOverrides.get(event.entityId);
    if (override) return [override.projectId];
    const scene = this.authoring.scenes.get(event.entityId);
    if (scene) return [scene.projectId];
    const story = this.authoring.stories.get(event.entityId);
    if (story) return [story.projectId];
    const page = this.creative.pages.get(event.entityId);
    if (page) return [page.projectId];
    const illustration = this.creative.illustrations.get(event.entityId);
    if (!illustration) return [];
    const illustrationPage = this.creative.pages.get(illustration.pageId);
    return illustrationPage ? [illustrationPage.projectId] : [];
  }

  apply(
    event: ChangeEvent,
    artifacts: readonly ResolvedArtifact[],
    consequences: readonly InvalidationConsequence[],
  ): void {
    const affected = new Set(
      consequences
        .filter((item) => printKinds.has(item.kind))
        .map((item) => `${item.kind}:${item.artifactId}`),
    );
    for (const runArtifact of artifacts.filter(
      (artifact) => artifact.kind === "print_run",
    )) {
      const run = runArtifact.record as PrintRun;
      const kinds = new Set(
        artifacts
          .filter(
            (artifact) =>
              runIdOf(artifact) === run.id &&
              affected.has(`${artifact.kind}:${artifact.id}`),
          )
          .map((artifact) => artifact.kind),
      );
      if (kinds.size === 0) continue;
      if (event.matrixRow === "IM-20") this.blockIntegrity(run, event);
      else this.staleRun(run, event, kinds);
    }
  }

  reconcileIntegrity(assetId: string): PrintRun[] {
    return this.store.transaction(() => {
      const repaired: PrintRun[] = [];
      for (const run of this.print.runs.list()) {
        if (
          run.state !== "blocked" ||
          !run.blockingReasons.includes("ASSET_INTEGRITY_BLOCKED") ||
          !this.referencesAsset(run, assetId) ||
          !this.allAssetsHealthy(run)
        )
          continue;
        this.releaseIntegrityPauses(run);
        const blockingReasons = run.blockingReasons.filter(
          (reason) => reason !== "ASSET_INTEGRITY_BLOCKED",
        );
        const state = blockingReasons.length
          ? "blocked"
          : this.restoredState(run);
        const at = this.now();
        const updated = this.print.runs.update(run.revision, {
          ...run,
          revision: run.revision + 1,
          updatedAt: at,
          state,
          blockingReasons,
        });
        this.setProjectPrintState(updated, state === "deliverable", at);
        repaired.push(updated);
      }
      return repaired;
    });
  }

  private resolveRun(run: PrintRun): ResolvedArtifact[] {
    const resolved: ResolvedArtifact[] = [artifact("print_run", run, run)];
    const interior = run.currentInteriorArtifactId
      ? this.print.artifacts.get(run.currentInteriorArtifactId)
      : null;
    const cover = run.currentCoverArtifactId
      ? this.print.artifacts.get(run.currentCoverArtifactId)
      : null;
    const report = run.currentPreflightReportId
      ? this.print.preflightReports.get(run.currentPreflightReportId)
      : null;
    const proof = run.convertedProofBundleHash
      ? (this.print.proofBundles
          .queryByField("runId", run.id)
          .find(
            (bundle) => bundle.bundleHash === run.convertedProofBundleHash,
          ) ?? null)
      : null;
    if (interior) resolved.push(artifact("print_interior", interior, run));
    if (cover) resolved.push(artifact("print_cover", cover, run));
    if (report) resolved.push(artifact("print_preflight", report, run));
    if (proof) resolved.push(artifact("print_proof", proof, run));
    return resolved;
  }

  private staleRun(
    run: PrintRun,
    event: ChangeEvent,
    kinds: ReadonlySet<string>,
  ): void {
    this.cancelProducerJobs(run);
    const invalidateInterior = kinds.has("print_interior");
    const invalidateCover = kinds.has("print_cover");
    const invalidatePreflight =
      kinds.has("print_preflight") || invalidateInterior || invalidateCover;
    const invalidateProof = kinds.has("print_proof") || invalidatePreflight;
    if (invalidateProof) this.cancelProofGate(run, event);
    const at = this.now();
    const updated = this.print.runs.update(run.revision, {
      ...run,
      revision: run.revision + 1,
      updatedAt: at,
      state: "stale",
      currentInteriorArtifactId: invalidateInterior
        ? null
        : run.currentInteriorArtifactId,
      currentCoverArtifactId: invalidateCover
        ? null
        : run.currentCoverArtifactId,
      currentPreflightReportId: invalidatePreflight
        ? null
        : run.currentPreflightReportId,
      convertedProofGateJobId: invalidateProof
        ? null
        : run.convertedProofGateJobId,
      convertedProofBundleHash: invalidateProof
        ? null
        : run.convertedProofBundleHash,
      blockingReasons: [],
      staleReasons: unique([
        ...run.staleReasons,
        matrixReason(event.matrixRow),
      ]),
      invalidatedByEventIds: unique([...run.invalidatedByEventIds, event.id]),
    });
    this.setProjectPrintState(updated, false, at);
  }

  private blockIntegrity(run: PrintRun, event: ChangeEvent): void {
    if (
      run.state === "blocked" &&
      run.blockingReasons.includes("ASSET_INTEGRITY_BLOCKED") &&
      run.invalidatedByEventIds.includes(event.id)
    )
      return;
    this.pauseProducerJobsForIntegrity(run);
    const at = this.now();
    const updated = this.print.runs.update(run.revision, {
      ...run,
      revision: run.revision + 1,
      updatedAt: at,
      state: "blocked",
      blockingReasons: unique([
        ...run.blockingReasons,
        "ASSET_INTEGRITY_BLOCKED",
      ]),
      invalidatedByEventIds: unique([...run.invalidatedByEventIds, event.id]),
    });
    this.setProjectPrintState(updated, false, at);
  }

  private cancelProofGate(run: PrintRun, event: ChangeEvent): void {
    if (!run.convertedProofGateJobId) return;
    const gate = this.gates.get(run.convertedProofGateJobId);
    if (!gate || gate.state !== "waiting_review") return;
    if (gate.request.kind !== "human_gate") return;
    this.gates.cancelOwnedHumanGate(
      gate.id,
      {
        expectedRevision: gate.revision,
        targetVersionId: gate.request.targetVersionId,
        reason: `print_invalidated_${event.matrixRow.toLowerCase()}`,
      },
      (candidate) =>
        candidate.projectId === run.projectId &&
        candidate.request.kind === "human_gate" &&
        candidate.request.gateKind === "print_converted_proof" &&
        candidate.request.targetId === run.id,
    );
  }

  private cancelProducerJobs(run: PrintRun): void {
    const owned = [
      {
        id: run.interiorJobId,
        jobTypes: ["print_interior", "print_interior_reuse"],
      },
      { id: run.coverJobId, jobTypes: ["print_cover"] },
      ...(run.preflightJobId
        ? [{ id: run.preflightJobId, jobTypes: ["print_preflight"] }]
        : []),
    ];
    for (const candidate of owned) {
      const job = this.gates.get(candidate.id);
      if (!job || terminalJobStates.has(job.state)) continue;
      if (
        job.projectId !== run.projectId ||
        job.request.kind !== "local" ||
        job.inputSnapshot.runId !== run.id ||
        !candidate.jobTypes.includes(job.jobType)
      )
        failPrint("PRINT_RUN_STALE");
      this.gates.cancel(job.id, {
        expectedRevision: job.revision,
        expectedState: job.state,
      });
    }
  }

  private pauseProducerJobsForIntegrity(run: PrintRun): void {
    for (const candidate of this.ownedProducerJobs(run)) {
      const job = this.gates.get(candidate.id);
      if (!job || terminalJobStates.has(job.state)) continue;
      this.assertProducerOwnership(run, candidate, job);
      this.gates.pauseOwnedForIntegrity(
        job.id,
        { expectedRevision: job.revision },
        (current) => this.isOwnedProducer(run, candidate, current),
      );
    }
  }

  private releaseIntegrityPauses(run: PrintRun): void {
    for (const candidate of this.ownedProducerJobs(run)) {
      const job = this.gates.get(candidate.id);
      if (
        !job ||
        job.state !== "paused" ||
        job.stateReason !== "asset_integrity"
      )
        continue;
      this.assertProducerOwnership(run, candidate, job);
      this.gates.releaseOwnedIntegrityPause(
        job.id,
        { expectedRevision: job.revision },
        (current) => this.isOwnedProducer(run, candidate, current),
      );
    }
  }

  private ownedProducerJobs(run: PrintRun): Array<{
    id: string;
    jobTypes: string[];
  }> {
    return [
      {
        id: run.interiorJobId,
        jobTypes: ["print_interior", "print_interior_reuse"],
      },
      { id: run.coverJobId, jobTypes: ["print_cover"] },
      ...(run.preflightJobId
        ? [{ id: run.preflightJobId, jobTypes: ["print_preflight"] }]
        : []),
    ];
  }

  private assertProducerOwnership(
    run: PrintRun,
    candidate: { id: string; jobTypes: string[] },
    job: JobRecord,
  ): void {
    if (!this.isOwnedProducer(run, candidate, job))
      failPrint("PRINT_RUN_STALE");
  }

  private isOwnedProducer(
    run: PrintRun,
    candidate: { id: string; jobTypes: string[] },
    job: JobRecord,
  ): boolean {
    return (
      job.id === candidate.id &&
      job.projectId === run.projectId &&
      job.request.kind === "local" &&
      job.inputSnapshot.runId === run.id &&
      candidate.jobTypes.includes(job.jobType)
    );
  }

  private referencesAsset(run: PrintRun, assetId: string): boolean {
    return this.referencedAssetIds(run).includes(assetId);
  }

  private referencedAssetIds(run: PrintRun): string[] {
    const version = this.print.profileVersions.get(run.printerProfileVersionId);
    const artifactIds = [
      run.currentInteriorArtifactId,
      run.currentCoverArtifactId,
    ].flatMap((id) => {
      const item = id ? this.print.artifacts.get(id) : null;
      return item ? [item.assetId] : [];
    });
    const proofAssets = this.print.proofBundles
      .queryByField("runId", run.id)
      .flatMap((bundle) =>
        bundle.representativeAssets.map((item) => item.assetId),
      );
    return unique([
      ...run.sourceAssets.map((source) => source.assetId),
      ...artifactIds,
      ...proofAssets,
      ...(version?.color.mode === "cmyk" ? [version.color.iccAssetId] : []),
      ...(version?.coverTemplate ? [version.coverTemplate.assetId] : []),
    ]);
  }

  private allAssetsHealthy(run: PrintRun): boolean {
    return this.referencedAssetIds(run).every((id) => {
      const integrity = this.assets.verifyIntegritySync(id);
      return integrity.status === "healthy";
    });
  }

  private restoredState(run: PrintRun): PrintRun["state"] {
    const report = run.currentPreflightReportId
      ? this.print.preflightReports.get(run.currentPreflightReportId)
      : null;
    if (report && !report.passed) return "blocked";
    if (report?.passed) {
      const interior = run.currentInteriorArtifactId
        ? this.print.artifacts.get(run.currentInteriorArtifactId)
        : null;
      if (interior?.colorMode === "rgb") return "deliverable";
      const gate = run.convertedProofGateJobId
        ? this.gates.get(run.convertedProofGateJobId)
        : null;
      if (gate?.state === "succeeded") return "deliverable";
      if (gate?.state === "waiting_review") return "converted_proof_pending";
    }
    if (run.currentInteriorArtifactId && run.currentCoverArtifactId)
      return "preflight_pending";
    if (run.currentInteriorArtifactId || run.currentCoverArtifactId)
      return "producing";
    return "queued";
  }

  private setProjectPrintState(
    run: PrintRun,
    deliverable: boolean,
    at: string,
  ): void {
    const project = this.authoring.projects.get(run.projectId);
    if (!project) return;
    const status = deliverable
      ? "print_ready"
      : project.currentContentApprovalId
        ? "approved"
        : "revising";
    if (project.status === status) return;
    this.authoring.projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: at,
      status,
    });
  }
}

function artifact(
  kind: ResolvedArtifact["kind"],
  record: PrintRun | PrintArtifact | PrintPreflightReport | PrintProofBundle,
  run: PrintRun,
): ResolvedArtifact {
  return {
    id: record.id,
    kind,
    locked: false,
    projectId: run.projectId,
    record,
  };
}

function runIdOf(artifact: ResolvedArtifact): string | null {
  if (artifact.kind === "print_run") return artifact.id;
  if (!printKinds.has(artifact.kind)) return null;
  const record = artifact.record as { runId?: unknown };
  return typeof record.runId === "string" ? record.runId : null;
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function matrixReason(row: ChangeEvent["matrixRow"]): string {
  return row.replace("-", "_");
}
