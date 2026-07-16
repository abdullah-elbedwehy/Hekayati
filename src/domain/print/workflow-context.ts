import type { AssetStore } from "../../assets/asset-store.js";
import type { JobScheduler } from "../../jobs/scheduler.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { Project } from "../authoring/schemas.js";
import type { ApprovedBookSnapshot } from "../layout/approvals.js";
import {
  createContentAuthorizationHash,
  hashCanonical,
} from "../layout/hashes.js";
import { LayoutRepositories } from "../layout/repositories.js";
import type {
  BookApprovalCycle,
  CoverCompositionVersion,
  PreviewOutput,
} from "../layout/schemas.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failPrint } from "./errors.js";
import { isValidCmykOutputProfileAsset } from "./profile-assets.js";
import { PrintRepositories } from "./repositories.js";
import type {
  PrinterProfile,
  PrinterProfileVersion,
  PrintRun,
} from "./schemas.js";
import type {
  MaterializationContext,
  ParsedPrintStartInput,
} from "./workflow-types.js";

interface CurrentSnapshot {
  output: PreviewOutput;
  cover: CoverCompositionVersion;
  sourceAssets: Array<{ role: string; assetId: string; checksum: string }>;
}

interface ApprovalRecords {
  cycle: BookApprovalCycle | null;
  output: PreviewOutput | null;
  cover: CoverCompositionVersion | null;
  gate: ReturnType<JobScheduler["get"]>;
}

export class PrintContextService {
  private readonly authoring: AuthoringRepositories;
  private readonly layout: LayoutRepositories;
  private readonly print: PrintRepositories;

  constructor(
    store: DocumentStore,
    private readonly assets: AssetStore,
    private readonly scheduler: JobScheduler,
  ) {
    this.authoring = new AuthoringRepositories(store);
    this.layout = new LayoutRepositories(store);
    this.print = new PrintRepositories(store);
  }

  load(
    input: ParsedPrintStartInput,
    snapshot: ApprovedBookSnapshot,
    enforceExpectedRevisions: boolean,
  ): MaterializationContext {
    const project = this.requireProject(input.projectId);
    this.assertProjectInput(project, input, snapshot, enforceExpectedRevisions);
    const { profile, version } = this.requireProfile(input);
    this.assertProfileInput(profile, version, input, enforceExpectedRevisions);
    const current = this.assertSnapshotCurrent(
      snapshot,
      project.currentContentApprovalId,
      project,
    );
    return buildContext(snapshot, current, profile, version);
  }

  guardRun(
    run: PrintRun,
    snapshot: ApprovedBookSnapshot,
  ): MaterializationContext {
    const project = this.requireProject(run.projectId);
    const profile = this.print.profiles.get(run.printerProfileId);
    const version = this.print.profileVersions.get(run.printerProfileVersionId);
    this.assertRunBindings(run, project, profile, version);
    const context = this.load(
      {
        owner: { customerId: run.customerId, familyId: run.familyId },
        projectId: run.projectId,
        expectedProjectRevision: project.revision,
        profileId: run.printerProfileId,
        expectedProfileRevision: profile!.revision,
        profileVersionId: run.printerProfileVersionId,
        contentAuthorizationHash: run.contentAuthorizationHash,
        idempotencyKey: run.idempotencyKey,
      },
      snapshot,
      false,
    );
    if (
      context.profileVersion.profileHash !== run.printerProfileHash ||
      context.sourceSnapshotHash !== run.sourceSnapshotHash
    )
      failPrint("PRINT_RUN_STALE");
    return context;
  }

  assertRunCurrent(run: PrintRun): void {
    const project = this.requireProject(run.projectId);
    const profile = this.print.profiles.get(run.printerProfileId);
    const version = this.print.profileVersions.get(run.printerProfileVersionId);
    this.assertRunBindings(run, project, profile, version);
    const snapshot = this.snapshotFromRun(run, project);
    const current = this.assertSnapshotCurrent(
      snapshot,
      project.currentContentApprovalId,
      project,
    );
    this.assertRunSources(run, current, version!);
  }

  assertProfileAssets(version: PrinterProfileVersion): void {
    if (version.color.mode === "cmyk") {
      if (
        !isValidCmykOutputProfileAsset(
          this.assets,
          version.color.iccAssetId,
          version.color.iccChecksum,
        )
      )
        failPrint("PRINT_RUN_STALE");
    }
    if (version.coverTemplate) {
      this.assertAsset(
        version.coverTemplate.assetId,
        "printer_template",
        version.coverTemplate.checksum,
      );
      this.assertHealthyChecksum(
        version.coverTemplate.assetId,
        version.coverTemplate.checksum,
      );
    }
  }

  private requireProject(projectId: string): Project {
    const project = this.authoring.projects.get(projectId);
    if (!project) failPrint("PRINT_ENTITY_NOT_FOUND");
    return project;
  }

  private requireProfile(input: ParsedPrintStartInput): {
    profile: PrinterProfile;
    version: PrinterProfileVersion;
  } {
    const profile = this.print.profiles.get(input.profileId);
    const version = this.print.profileVersions.get(input.profileVersionId);
    if (!profile) failPrint("PRINTER_PROFILE_NOT_FOUND");
    if (!version) failPrint("PRINTER_PROFILE_VERSION_NOT_FOUND");
    return { profile, version };
  }

  private assertProjectInput(
    project: Project,
    input: ParsedPrintStartInput,
    snapshot: ApprovedBookSnapshot,
    enforceRevision: boolean,
  ): void {
    if (
      project.customerId !== input.owner.customerId ||
      project.familyId !== input.owner.familyId
    )
      failPrint("PRINT_SCOPE_REJECTED");
    if (enforceRevision && project.revision !== input.expectedProjectRevision)
      failPrint("PRINT_REVISION_CONFLICT");
    if (project.printerProfileId !== input.profileId)
      failPrint("PRINT_REVISION_CONFLICT");
    if (snapshot.contentAuthorizationHash !== input.contentAuthorizationHash)
      failPrint("PRINT_AUTHORIZATION_MISMATCH");
  }

  private assertProfileInput(
    profile: PrinterProfile,
    version: PrinterProfileVersion,
    input: ParsedPrintStartInput,
    enforceRevision: boolean,
  ): void {
    if (
      (enforceRevision && profile.revision !== input.expectedProfileRevision) ||
      profile.currentVersionId !== version.id ||
      version.profileId !== profile.id
    )
      failPrint("PRINT_REVISION_CONFLICT");
    if (profile.archived) failPrint("PRINTER_PROFILE_ARCHIVED");
    if (version.readiness !== "ready")
      failPrint("PRINTER_PROFILE_INCOMPLETE", {
        blockingReasons: version.blockingReasons,
      });
    this.assertProfileAssets(version);
  }

  private assertRunBindings(
    run: PrintRun,
    project: Project,
    profile: PrinterProfile | null,
    version: PrinterProfileVersion | null,
  ): void {
    if (
      project.customerId !== run.customerId ||
      project.familyId !== run.familyId ||
      project.currentContentApprovalId !== run.approvalCycleId ||
      project.printerProfileId !== run.printerProfileId ||
      !profile ||
      profile.archived ||
      profile.currentVersionId !== run.printerProfileVersionId ||
      !version ||
      version.profileHash !== run.printerProfileHash ||
      version.readiness !== "ready"
    )
      failPrint("PRINT_RUN_STALE");
  }

  private snapshotFromRun(
    run: PrintRun,
    project: Project,
  ): ApprovedBookSnapshot {
    const output = this.layout.previewOutputs.get(run.previewOutputId);
    if (!output) failPrint("PRINT_RUN_STALE");
    const cover = this.layout.coverCompositionVersions.get(
      output.coverCompositionVersionId,
    );
    return {
      projectId: run.projectId,
      projectVersionId: output.projectVersionId,
      compositionProfileId: run.compositionProfileId,
      coverCompositionVersionId: output.coverCompositionVersionId,
      approvalCycleId: run.approvalCycleId,
      previewOutputId: run.previewOutputId,
      approvalGateJobId: run.approvalGateJobId,
      customerContentHash: run.customerContentHash,
      contentAuthorizationHash: run.contentAuthorizationHash,
      orderedInteriorPages: output.orderedInteriorPages,
      coverSourceAssets: cover?.sourceAssets ?? [],
      observations: {
        projectRevision: project.revision,
        bookVersion: project.bookVersion,
        previewOutputRevision: output.revision,
        approvalRevision: 0,
        pageObservationRevisions: [],
      },
    };
  }

  private assertRunSources(
    run: PrintRun,
    current: CurrentSnapshot,
    version: PrinterProfileVersion,
  ): void {
    if (
      current.output.compositionProfileHash !== run.compositionProfileHash ||
      hashCanonical(current.sourceAssets) !== hashCanonical(run.sourceAssets)
    )
      failPrint("PRINT_RUN_STALE");
    for (const source of run.sourceAssets)
      this.assertHealthyChecksum(source.assetId, source.checksum);
    this.assertProfileAssets(version);
  }

  private assertSnapshotCurrent(
    snapshot: ApprovedBookSnapshot,
    currentContentApprovalId: string | null,
    project: Project,
  ): CurrentSnapshot {
    const records = this.approvalRecords(snapshot);
    this.assertApprovalLinks(
      snapshot,
      currentContentApprovalId,
      project,
      records,
    );
    this.assertAuthorization(snapshot, records);
    const sourceAssets = uniqueSources([
      ...records.output!.orderedInteriorPages.flatMap(
        (page) => page.sourceAssets,
      ),
      ...records.cover!.sourceAssets,
    ]);
    for (const source of sourceAssets)
      this.assertHealthyChecksum(source.assetId, source.checksum);
    return {
      output: records.output!,
      cover: records.cover!,
      sourceAssets,
    };
  }

  private approvalRecords(snapshot: ApprovedBookSnapshot): ApprovalRecords {
    const output = this.layout.previewOutputs.get(snapshot.previewOutputId);
    return {
      cycle: this.layout.bookApprovalCycles.get(snapshot.approvalCycleId),
      output,
      cover: this.layout.coverCompositionVersions.get(
        snapshot.coverCompositionVersionId,
      ),
      gate: this.scheduler.get(snapshot.approvalGateJobId),
    };
  }

  private assertApprovalLinks(
    snapshot: ApprovedBookSnapshot,
    currentContentApprovalId: string | null,
    project: Project,
    records: ApprovalRecords,
  ): void {
    if (
      !approvalRootsMatch(
        snapshot,
        currentContentApprovalId,
        project,
        records,
      ) ||
      !approvalDocumentsMatch(snapshot, project, records) ||
      !approvalGateMatches(snapshot, project, records)
    )
      failPrint("PRINT_AUTHORIZATION_MISMATCH");
  }

  private assertAuthorization(
    snapshot: ApprovedBookSnapshot,
    records: ApprovalRecords,
  ): void {
    const { cycle, output, cover, gate } = records;
    if (!cycle || !output || !cover || !gate)
      failPrint("PRINT_AUTHORIZATION_MISMATCH");
    const reviewEvidenceHash = hashCanonical(
      output.orderedInteriorPages.map((page) => ({
        pageId: page.pageId,
        pageReviewId: page.pageReviewId,
        reviewHash: page.reviewHash,
      })),
    );
    const authorization = createContentAuthorizationHash({
      customerContentHash: cycle.customerContentHash,
      previewOutputId: output.id,
      approvalCycleId: cycle.id,
      approvalGateJobId: gate.id,
      approvedOutcome: "approved",
      reviewEvidenceHash,
    });
    if (
      authorization !== snapshot.contentAuthorizationHash ||
      hashCanonical(output.orderedInteriorPages) !==
        hashCanonical(snapshot.orderedInteriorPages) ||
      hashCanonical(cover.sourceAssets) !==
        hashCanonical(snapshot.coverSourceAssets)
    )
      failPrint("PRINT_AUTHORIZATION_MISMATCH");
  }

  private assertAsset(id: string, role: string, checksum: string): void {
    const asset = this.assets.get(id);
    if (!asset || asset.role !== role || asset.sha256 !== checksum)
      failPrint("PRINTER_PROFILE_ASSET_INVALID");
  }

  private assertHealthyChecksum(id: string, checksum: string): void {
    let integrity: ReturnType<AssetStore["verifyIntegritySync"]>;
    try {
      integrity = this.assets.verifyIntegritySync(id);
    } catch {
      failPrint("PRINT_RUN_STALE");
    }
    if (integrity.status !== "healthy" || integrity.expectedSha256 !== checksum)
      failPrint("PRINT_RUN_STALE");
  }
}

function approvalRootsMatch(
  snapshot: ApprovedBookSnapshot,
  currentContentApprovalId: string | null,
  project: Project,
  records: ApprovalRecords,
): boolean {
  const { cycle, output, cover } = records;
  return Boolean(
    snapshot.projectId === project.id &&
    snapshot.projectVersionId === project.currentVersionId &&
    snapshot.compositionProfileId === project.compositionProfileId &&
    currentContentApprovalId === snapshot.approvalCycleId &&
    cycle?.id === snapshot.approvalCycleId &&
    cycle.state === "approved" &&
    output?.id === snapshot.previewOutputId &&
    authorizationOutputState(output) &&
    cover?.id === snapshot.coverCompositionVersionId,
  );
}

function approvalDocumentsMatch(
  snapshot: ApprovedBookSnapshot,
  project: Project,
  records: ApprovalRecords,
): boolean {
  const { cycle, output, cover } = records;
  if (!cycle || !output || !cover) return false;
  return (
    cycle.projectId === project.id &&
    output.projectId === project.id &&
    cover.projectId === project.id &&
    output.projectVersionId === snapshot.projectVersionId &&
    cover.projectVersionId === snapshot.projectVersionId &&
    output.compositionProfileId === snapshot.compositionProfileId &&
    cover.compositionProfileId === snapshot.compositionProfileId &&
    output.compositionProfileHash === cover.compositionProfileHash &&
    output.coverCompositionVersionId === cover.id &&
    output.approvalCycleId === cycle.id &&
    output.approvalGateJobId === snapshot.approvalGateJobId &&
    cycle.previewOutputId === output.id &&
    cycle.approvalGateJobId === snapshot.approvalGateJobId &&
    cycle.targetBookVersion === output.bookVersion &&
    output.bookVersion === project.bookVersion &&
    approvalHashesMatch(snapshot, cycle, output)
  );
}

function approvalHashesMatch(
  snapshot: ApprovedBookSnapshot,
  cycle: NonNullable<ApprovalRecords["cycle"]>,
  output: NonNullable<ApprovalRecords["output"]>,
): boolean {
  return (
    cycle.customerContentHash === snapshot.customerContentHash &&
    output.customerContentHash === snapshot.customerContentHash &&
    cycle.approvalBundleHash === output.approvalBundleHash &&
    cycle.pageMapHash === output.pageMapHash &&
    cycle.previewSnapshotHash === output.previewSnapshotHash &&
    cycle.coverCompositionVersionId === output.coverCompositionVersionId &&
    cycle.watermarkSettingsHash === output.watermarkSettingsHash
  );
}

function approvalGateMatches(
  snapshot: ApprovedBookSnapshot,
  project: Project,
  records: ApprovalRecords,
): boolean {
  const { output, gate } = records;
  return Boolean(
    output &&
    gate?.id === snapshot.approvalGateJobId &&
    gate.projectId === project.id &&
    gate.state === "succeeded" &&
    gate.request.kind === "human_gate" &&
    gate.request.gateKind === "customer_approval" &&
    gate.request.targetId === project.id &&
    gate.request.targetVersionId === output.id,
  );
}

function authorizationOutputState(output: PreviewOutput): boolean {
  return (
    output.status === "ready" ||
    (output.status === "stale" &&
      output.staleReasons.length > 0 &&
      output.staleReasons.every((row) => row === "IM-19" || row === "IM-20"))
  );
}

function buildContext(
  snapshot: ApprovedBookSnapshot,
  current: CurrentSnapshot,
  profile: PrinterProfile,
  profileVersion: PrinterProfileVersion,
): MaterializationContext {
  return {
    snapshot,
    output: current.output,
    cover: current.cover,
    profile,
    profileVersion,
    compositionProfileHash: current.output.compositionProfileHash,
    sourceAssets: current.sourceAssets,
    sourceSnapshotHash: hashCanonical(snapshotIdentity(snapshot)),
  };
}

function snapshotIdentity(snapshot: ApprovedBookSnapshot) {
  return {
    projectId: snapshot.projectId,
    projectVersionId: snapshot.projectVersionId,
    compositionProfileId: snapshot.compositionProfileId,
    coverCompositionVersionId: snapshot.coverCompositionVersionId,
    approvalCycleId: snapshot.approvalCycleId,
    previewOutputId: snapshot.previewOutputId,
    approvalGateJobId: snapshot.approvalGateJobId,
    customerContentHash: snapshot.customerContentHash,
    contentAuthorizationHash: snapshot.contentAuthorizationHash,
    orderedInteriorPages: snapshot.orderedInteriorPages,
    coverSourceAssets: snapshot.coverSourceAssets,
  };
}

function uniqueSources<T extends { role: string; assetId: string }>(
  sources: readonly T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const source of sources)
    byKey.set(`${source.role}:${source.assetId}`, source);
  return [...byKey.values()].sort((left, right) => {
    const a = `${left.role}:${left.assetId}`;
    const b = `${right.role}:${right.assetId}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
