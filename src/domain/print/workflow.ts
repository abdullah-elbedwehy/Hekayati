import { ulid } from "ulid";

import type { AssetStore } from "../../assets/asset-store.js";
import type { JobRecord } from "../../jobs/schemas.js";
import type { JobScheduler } from "../../jobs/scheduler.js";
import type { EnqueueJobInput } from "../../jobs/types.js";
import type {
  ApprovedBookSnapshot,
  ApprovedBookSnapshotReader,
} from "../layout/approvals.js";
import { hashCanonical } from "../layout/hashes.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failPrint } from "./errors.js";
import { interiorProfileHash } from "./interior-profile.js";
import { PrintRepositories } from "./repositories.js";
import type {
  PrinterProfileVersion,
  PrintArtifact,
  PrintRun,
} from "./schemas.js";
import { PrintCommitService } from "./workflow-commits.js";
import { PrintContextService } from "./workflow-context.js";
import {
  printStartInputSchema,
  type MaterializationContext,
  type ParsedPrintStartInput,
  type PreparedPrintArtifactCommit,
  type PreparedPrintPreflightCommit,
  type PrintArtifactCommitResult,
  type PrintPreflightCommitResult,
  type PrintProductionOptions,
  type PrintStartInput,
  type PrintStartResult,
} from "./workflow-types.js";

export type {
  MaterializationContext,
  PreparedPrintArtifactCommit,
  PreparedPrintPreflightCommit,
  PrintArtifactCommitResult,
  PrintPreflightCommitResult,
  PrintProductionOptions,
  PrintStartInput,
  PrintStartResult,
} from "./workflow-types.js";

interface RunIds {
  run: string;
  interiorJob: string;
  coverJob: string;
}

interface InteriorReuseCandidate {
  artifact: PrintArtifact;
  sourceRun: PrintRun;
  profileHash: string;
}

export class PrintProductionService {
  private readonly print: PrintRepositories;
  private readonly context: PrintContextService;
  private readonly commits: PrintCommitService;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    private readonly assets: AssetStore,
    private readonly scheduler: JobScheduler,
    private readonly approvedBooks: Pick<ApprovedBookSnapshotReader, "read">,
    options: PrintProductionOptions = {},
  ) {
    this.print = new PrintRepositories(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.context = new PrintContextService(store, assets, scheduler);
    this.commits = new PrintCommitService(
      store,
      assets,
      scheduler,
      this.context,
      this.now,
      this.idFactory,
    );
  }

  async start(input: PrintStartInput): Promise<PrintStartResult> {
    const parsed = printStartInputSchema.parse(input);
    const requestHash = hashCanonical(canonicalStartRequest(parsed));
    const stored = this.store.transaction(() =>
      this.findReplay(parsed, requestHash),
    );
    if (stored) return stored;
    const snapshot = await this.approvedBooks.read(parsed.projectId);
    return this.store.transaction(() =>
      this.materializeInTransaction(parsed, snapshot, requestHash),
    );
  }

  async guardRun(
    runId: string,
  ): Promise<MaterializationContext & { run: PrintRun }> {
    const observed = this.requireRun(runId);
    const snapshot = await this.approvedBooks.read(observed.projectId);
    return this.store.transaction(() => {
      const run = this.requireRun(runId);
      if (["stale", "blocked", "rejected"].includes(run.state))
        failPrint("PRINT_RUN_STALE");
      return { ...this.context.guardRun(run, snapshot), run };
    });
  }

  commitArtifact(
    job: Readonly<JobRecord>,
    prepared: PreparedPrintArtifactCommit,
  ): PrintArtifactCommitResult {
    return this.commits.commitArtifact(job, prepared);
  }

  commitReusedInterior(job: Readonly<JobRecord>): PrintArtifactCommitResult {
    return this.commits.commitReusedInterior(job);
  }

  commitPreflight(
    job: Readonly<JobRecord>,
    prepared: PreparedPrintPreflightCommit,
  ): PrintPreflightCommitResult {
    return this.commits.commitPreflight(job, prepared);
  }

  private materializeInTransaction(
    input: ParsedPrintStartInput,
    snapshot: ApprovedBookSnapshot,
    requestHash: string,
  ): PrintStartResult {
    const replay = this.findReplay(input, requestHash);
    if (replay) return replay;
    const context = this.context.load(input, snapshot, true);
    const ids = this.createRunIds();
    const reuse = this.findReusableInterior(context);
    const jobs = this.enqueueProducers(ids, input, context, reuse);
    const run = this.insertRun(ids.run, input, context, requestHash, jobs);
    return { run, jobs, replayed: false };
  }

  private findReplay(
    input: ParsedPrintStartInput,
    requestHash: string,
  ): PrintStartResult | null {
    const byKey = this.print.runs
      .queryByField("idempotencyKey", input.idempotencyKey)
      .find((run) => run.projectId === input.projectId);
    if (byKey) {
      if (byKey.requestHash !== requestHash)
        failPrint("PRINT_IDEMPOTENCY_COLLISION");
      return this.replayResult(byKey);
    }
    const canonical = this.print.runs
      .queryByField("requestHash", requestHash)
      .find((run) => run.projectId === input.projectId);
    return canonical ? this.replayResult(canonical) : null;
  }

  private createRunIds(): RunIds {
    return {
      run: this.idFactory(),
      interiorJob: this.idFactory(),
      coverJob: this.idFactory(),
    };
  }

  private enqueueProducers(
    ids: RunIds,
    input: ParsedPrintStartInput,
    context: MaterializationContext,
    reuse: InteriorReuseCandidate | null,
  ): [JobRecord, JobRecord] {
    return this.scheduler.enqueueMany([
      reuse
        ? interiorReuseJobInput(ids.interiorJob, ids.run, input, context, reuse)
        : printJobInput("interior", ids.interiorJob, ids.run, input, context),
      printJobInput("cover", ids.coverJob, ids.run, input, context),
    ]) as [JobRecord, JobRecord];
  }

  private findReusableInterior(
    context: MaterializationContext,
  ): InteriorReuseCandidate | null {
    const candidates = this.print.runs
      .queryByField("projectId", context.snapshot.projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const sourceRun of candidates) {
      const artifact = sourceRun.currentInteriorArtifactId
        ? this.print.artifacts.get(sourceRun.currentInteriorArtifactId)
        : null;
      const sourceVersion = this.print.profileVersions.get(
        sourceRun.printerProfileVersionId,
      );
      if (
        artifact &&
        sourceVersion &&
        this.isReusableInterior(sourceRun, artifact, sourceVersion, context)
      )
        return {
          artifact,
          sourceRun,
          profileHash: interiorProfileHash(sourceVersion),
        };
    }
    return null;
  }

  private isReusableInterior(
    run: PrintRun,
    artifact: PrintArtifact,
    sourceVersion: PrinterProfileVersion,
    context: MaterializationContext,
  ): boolean {
    const snapshot = context.snapshot;
    const sameLineage =
      run.state === "stale" &&
      run.staleReasons.includes("IM_15") &&
      artifact.kind === "interior" &&
      artifact.runId === run.id &&
      artifact.printerProfileHash === run.printerProfileHash &&
      run.contentAuthorizationHash === snapshot.contentAuthorizationHash &&
      run.approvalCycleId === snapshot.approvalCycleId &&
      run.previewOutputId === snapshot.previewOutputId &&
      run.compositionProfileHash === context.compositionProfileHash &&
      run.sourceSnapshotHash === context.sourceSnapshotHash &&
      artifact.sourceSnapshotHash === context.sourceSnapshotHash &&
      hashCanonical(run.sourceAssets) === hashCanonical(context.sourceAssets);
    if (
      !sameLineage ||
      interiorProfileHash(sourceVersion) !==
        interiorProfileHash(context.profileVersion)
    )
      return false;
    const integrity = this.assets.verifyIntegritySync(artifact.assetId);
    return (
      integrity.status === "healthy" &&
      integrity.expectedSha256 === artifact.checksum
    );
  }

  private insertRun(
    runId: string,
    input: ParsedPrintStartInput,
    context: MaterializationContext,
    requestHash: string,
    jobs: [JobRecord, JobRecord],
  ): PrintRun {
    const at = this.now();
    return this.print.runs.insert({
      id: runId,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      revision: 0,
      projectId: input.projectId,
      familyId: input.owner.familyId,
      customerId: input.owner.customerId,
      requestHash,
      idempotencyKey: input.idempotencyKey,
      ...approvalBinding(context),
      ...profileBinding(context),
      ...initialRunState(jobs),
    });
  }

  private requireRun(id: string): PrintRun {
    const run = this.print.runs.get(id);
    if (!run) failPrint("PRINT_ENTITY_NOT_FOUND");
    return run;
  }

  private replayResult(run: PrintRun): PrintStartResult {
    return {
      run,
      jobs: [
        this.requireJob(run.interiorJobId),
        this.requireJob(run.coverJobId),
      ],
      replayed: true,
    };
  }

  private requireJob(id: string): JobRecord {
    const job = this.scheduler.get(id);
    if (!job) failPrint("PRINT_ENTITY_NOT_FOUND");
    return job;
  }
}

function canonicalStartRequest(input: ParsedPrintStartInput) {
  return {
    owner: input.owner,
    projectId: input.projectId,
    expectedProjectRevision: input.expectedProjectRevision,
    profileId: input.profileId,
    expectedProfileRevision: input.expectedProfileRevision,
    profileVersionId: input.profileVersionId,
    contentAuthorizationHash: input.contentAuthorizationHash,
  };
}

function printJobInput(
  kind: "interior" | "cover",
  id: string,
  runId: string,
  input: ParsedPrintStartInput,
  context: MaterializationContext,
): EnqueueJobInput {
  const payloadHash = hashCanonical({
    kind,
    runId,
    contentAuthorizationHash: input.contentAuthorizationHash,
    printerProfileVersionId: context.profileVersion.id,
    printerProfileHash: context.profileVersion.profileHash,
    sourceSnapshotHash: context.sourceSnapshotHash,
  });
  return {
    id,
    jobType: kind === "interior" ? "print_interior" : "print_cover",
    projectId: input.projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: `print-${kind}-${runId}`,
    target: null,
    request: { kind: "local", payloadHash },
    inputSnapshot: {
      runId,
      contentAuthorizationHash: input.contentAuthorizationHash,
      printerProfileVersionId: context.profileVersion.id,
      printerProfileHash: context.profileVersion.profileHash,
      sourceSnapshotHash: context.sourceSnapshotHash,
    },
  };
}

function interiorReuseJobInput(
  id: string,
  runId: string,
  input: ParsedPrintStartInput,
  context: MaterializationContext,
  reuse: InteriorReuseCandidate,
): EnqueueJobInput {
  const identity = {
    runId,
    reusedArtifactId: reuse.artifact.id,
    reusedArtifactChecksum: reuse.artifact.checksum,
    sourceRunId: reuse.sourceRun.id,
    interiorProfileHash: reuse.profileHash,
    contentAuthorizationHash: input.contentAuthorizationHash,
    printerProfileVersionId: context.profileVersion.id,
    printerProfileHash: context.profileVersion.profileHash,
    sourceSnapshotHash: context.sourceSnapshotHash,
  };
  return {
    id,
    jobType: "print_interior_reuse",
    projectId: input.projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: `print-interior-reuse-${runId}`,
    target: null,
    request: { kind: "local", payloadHash: hashCanonical(identity) },
    inputSnapshot: identity,
  };
}

function approvalBinding(context: MaterializationContext) {
  const snapshot = context.snapshot;
  return {
    contentAuthorizationHash: snapshot.contentAuthorizationHash,
    approvalCycleId: snapshot.approvalCycleId,
    approvalGateJobId: snapshot.approvalGateJobId,
    previewOutputId: snapshot.previewOutputId,
    customerContentHash: snapshot.customerContentHash,
    compositionProfileId: snapshot.compositionProfileId,
    compositionProfileHash: context.compositionProfileHash,
  };
}

function profileBinding(context: MaterializationContext) {
  return {
    printerProfileId: context.profile.id,
    printerProfileVersionId: context.profileVersion.id,
    printerProfileHash: context.profileVersion.profileHash,
    sourceSnapshotHash: context.sourceSnapshotHash,
    sourceAssets: context.sourceAssets,
  };
}

function initialRunState(jobs: [JobRecord, JobRecord]) {
  return {
    state: "queued" as const,
    interiorJobId: jobs[0].id,
    coverJobId: jobs[1].id,
    preflightJobId: null,
    convertedProofGateJobId: null,
    currentInteriorArtifactId: null,
    currentCoverArtifactId: null,
    currentPreflightReportId: null,
    convertedProofBundleHash: null,
    blockingReasons: [],
    staleReasons: [],
    invalidatedByEventIds: [],
  };
}
