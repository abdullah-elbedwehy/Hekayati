import { ulid } from "ulid";
import { z } from "zod";

import type { AssetStore } from "../../assets/asset-store.js";
import type { JobRecord } from "../../jobs/schemas.js";
import type { JobScheduler } from "../../jobs/scheduler.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import { hashCanonical } from "../layout/hashes.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failPrint } from "./errors.js";
import { PrintRepositories } from "./repositories.js";
import { PrintContextService } from "./workflow-context.js";
import type {
  ConvertedProofAction,
  PrintProofBundle,
  PrintRun,
} from "./schemas.js";

const entityIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema = z
  .object({
    owner: z
      .object({ customerId: entityIdSchema, familyId: entityIdSchema })
      .strict(),
    runId: entityIdSchema,
    proofBundleId: entityIdSchema,
    gateJobId: entityIdSchema,
    action: z.enum(["approved", "rejected"]),
    idempotencyKey: z.string().trim().min(1).max(160),
    expectedRunRevision: z.number().int().nonnegative(),
    expectedGateRevision: z.number().int().nonnegative(),
    proofBundleHash: hashSchema,
    contentAuthorizationHash: hashSchema,
    printerProfileHash: hashSchema,
    iccChecksum: hashSchema,
    notes: z.string().max(1_000).optional(),
  })
  .strict();

export interface ConvertedProofServiceOptions {
  now?: () => string;
  idFactory?: () => string;
}

export interface ConvertedProofResult {
  actionId: string;
  replayed: boolean;
  action: "approved" | "rejected";
  runRevision: number;
  gateRevision: number;
  runState: "deliverable" | "rejected";
}

export class ConvertedProofService {
  private readonly print: PrintRepositories;
  private readonly authoring: AuthoringRepositories;
  private readonly context: PrintContextService;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    private readonly assets: AssetStore,
    private readonly scheduler: JobScheduler,
    options: ConvertedProofServiceOptions = {},
  ) {
    this.print = new PrintRepositories(store);
    this.authoring = new AuthoringRepositories(store);
    this.context = new PrintContextService(store, assets, scheduler);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  act(input: z.input<typeof inputSchema>): ConvertedProofResult {
    const parsed = inputSchema.parse(input);
    const normalizedNotes = normalizeNotes(parsed.notes ?? "");
    if (parsed.action === "rejected" && !normalizedNotes)
      failPrint("PRINT_PROOF_ACTION_INVALID");
    if (parsed.action === "approved" && normalizedNotes)
      failPrint("PRINT_PROOF_ACTION_INVALID");
    const requestHash = hashCanonical({ ...parsed, notes: normalizedNotes });
    return this.store.transaction(() =>
      this.actInTransaction(parsed, normalizedNotes, requestHash),
    );
  }

  private actInTransaction(
    input: z.infer<typeof inputSchema>,
    normalizedNotes: string,
    requestHash: string,
  ): ConvertedProofResult {
    const replay = this.print.proofActions
      .queryByField("idempotencyKey", input.idempotencyKey)
      .find((action) => action.runId === input.runId);
    if (replay) {
      if (replay.canonicalRequestHash !== requestHash)
        failPrint("PRINT_PROOF_ACTION_COLLISION");
      return result(replay, true);
    }
    const context = this.loadContext(input);
    const at = this.now();
    const gate = this.applyGate(input.action, context);
    const run = this.applyRun(input.action, context.run, at);
    const action = this.recordAction({
      input,
      normalizedNotes,
      requestHash,
      run,
      gate,
      at,
    });
    return result(action, false);
  }

  private applyGate(
    action: "approved" | "rejected",
    context: { run: PrintRun; bundle: PrintProofBundle; gate: JobRecord },
  ): JobRecord {
    const input = {
      expectedRevision: context.gate.revision,
      targetVersionId: context.bundle.id,
    };
    const verify = (candidate: JobRecord) =>
      ownsProofGate(candidate, context.run, context.bundle);
    return action === "approved"
      ? this.scheduler.completeHumanGate(context.gate.id, input, verify)
      : this.scheduler.cancelOwnedHumanGate(
          context.gate.id,
          { ...input, reason: "converted_proof_rejected" },
          verify,
        );
  }

  private applyRun(
    action: "approved" | "rejected",
    current: PrintRun,
    at: string,
  ): PrintRun {
    const run = this.print.runs.update(current.revision, {
      ...current,
      revision: current.revision + 1,
      updatedAt: at,
      state: action === "approved" ? "deliverable" : "rejected",
      blockingReasons:
        action === "approved" ? [] : ["CONVERTED_PROOF_REJECTED"],
    });
    if (action === "approved") this.markProjectReady(run.projectId, at);
    return run;
  }

  private markProjectReady(projectId: string, at: string): void {
    const project = this.authoring.projects.get(projectId);
    if (!project) failPrint("PRINT_ENTITY_NOT_FOUND");
    this.authoring.projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: at,
      status: "print_ready",
    });
  }

  private recordAction(input: {
    input: z.infer<typeof inputSchema>;
    normalizedNotes: string;
    requestHash: string;
    run: PrintRun;
    gate: JobRecord;
    at: string;
  }): ConvertedProofAction {
    const request = input.input;
    return this.print.proofActions.insert({
      id: this.idFactory(),
      schemaVersion: 1,
      createdAt: input.at,
      updatedAt: input.at,
      runId: input.run.id,
      gateJobId: input.gate.id,
      ownerCustomerId: request.owner.customerId,
      ownerFamilyId: request.owner.familyId,
      action: request.action,
      idempotencyKey: request.idempotencyKey,
      canonicalRequestHash: input.requestHash,
      expectedRunRevision: request.expectedRunRevision,
      expectedGateRevision: request.expectedGateRevision,
      proofBundleHash: request.proofBundleHash,
      contentAuthorizationHash: request.contentAuthorizationHash,
      printerProfileHash: request.printerProfileHash,
      iccChecksum: request.iccChecksum,
      normalizedNotes: input.normalizedNotes,
      resultRunRevision: input.run.revision,
      resultGateRevision: input.gate.revision,
      recordedAt: input.at,
    });
  }

  private loadContext(parsed: z.infer<typeof inputSchema>): {
    run: PrintRun;
    bundle: PrintProofBundle;
    gate: JobRecord;
  } {
    const { run, bundle, gate } = this.loadRecords(parsed);
    const project = this.authoring.projects.get(run.projectId);
    const report = run.currentPreflightReportId
      ? this.print.preflightReports.get(run.currentPreflightReportId)
      : null;
    const interior = run.currentInteriorArtifactId
      ? this.print.artifacts.get(run.currentInteriorArtifactId)
      : null;
    const cover = run.currentCoverArtifactId
      ? this.print.artifacts.get(run.currentCoverArtifactId)
      : null;
    this.assertContextBindings(
      parsed,
      { run, bundle, gate },
      {
        project,
        report,
        interior,
        cover,
      },
    );
    this.context.assertRunCurrent(run);
    if (!interior || !cover) failPrint("PRINT_PROOF_ACTION_INVALID");
    this.assertProofIntegrity(bundle, interior, cover);
    return { run, bundle, gate };
  }

  private loadRecords(parsed: z.infer<typeof inputSchema>): {
    run: PrintRun;
    bundle: PrintProofBundle;
    gate: JobRecord;
  } {
    const run = this.print.runs.get(parsed.runId);
    const bundle = this.print.proofBundles.get(parsed.proofBundleId);
    const gate = this.scheduler.get(parsed.gateJobId);
    if (!run || !bundle || !gate) failPrint("PRINT_PROOF_ACTION_INVALID");
    return { run, bundle, gate };
  }

  private assertContextBindings(
    parsed: z.infer<typeof inputSchema>,
    context: { run: PrintRun; bundle: PrintProofBundle; gate: JobRecord },
    records: {
      project: ReturnType<AuthoringRepositories["projects"]["get"]>;
      report: ReturnType<PrintRepositories["preflightReports"]["get"]>;
      interior: ReturnType<PrintRepositories["artifacts"]["get"]>;
      cover: ReturnType<PrintRepositories["artifacts"]["get"]>;
    },
  ): void {
    const { run, bundle, gate } = context;
    const { project, report, interior, cover } = records;
    if (
      !project ||
      project.customerId !== parsed.owner.customerId ||
      project.familyId !== parsed.owner.familyId
    )
      failPrint("PRINT_SCOPE_REJECTED");
    if (
      run.revision !== parsed.expectedRunRevision ||
      gate.revision !== parsed.expectedGateRevision
    )
      failPrint("PRINT_REVISION_CONFLICT");
    if (
      run.state !== "converted_proof_pending" ||
      run.convertedProofGateJobId !== gate.id ||
      run.convertedProofBundleHash !== bundle.bundleHash ||
      bundle.runId !== run.id ||
      bundle.gateJobId !== gate.id ||
      bundle.bundleHash !== parsed.proofBundleHash ||
      run.contentAuthorizationHash !== parsed.contentAuthorizationHash ||
      run.printerProfileHash !== parsed.printerProfileHash ||
      bundle.contentAuthorizationHash !== parsed.contentAuthorizationHash ||
      bundle.printerProfileHash !== parsed.printerProfileHash ||
      bundle.iccChecksum !== parsed.iccChecksum ||
      !report?.passed ||
      !interior ||
      !cover ||
      interior.id !== bundle.interiorArtifactId ||
      interior.checksum !== bundle.interiorChecksum ||
      cover.id !== bundle.coverArtifactId ||
      cover.checksum !== bundle.coverChecksum ||
      !ownsProofGate(gate, run, bundle)
    )
      failPrint("PRINT_PROOF_ACTION_INVALID");
  }

  private assertProofIntegrity(
    bundle: PrintProofBundle,
    interior: NonNullable<ReturnType<PrintRepositories["artifacts"]["get"]>>,
    cover: NonNullable<ReturnType<PrintRepositories["artifacts"]["get"]>>,
  ): void {
    for (const reference of [
      { assetId: interior.assetId, checksum: interior.checksum },
      { assetId: cover.assetId, checksum: cover.checksum },
      ...bundle.representativeAssets,
    ]) {
      const integrity = this.assets.verifyIntegritySync(reference.assetId);
      if (
        integrity.status !== "healthy" ||
        integrity.expectedSha256 !== reference.checksum
      )
        failPrint("PRINT_PROOF_ACTION_INVALID");
    }
  }
}

function ownsProofGate(
  job: JobRecord,
  run: PrintRun,
  bundle: PrintProofBundle,
): boolean {
  return (
    job.projectId === run.projectId &&
    job.state === "waiting_review" &&
    job.request.kind === "human_gate" &&
    job.request.gateKind === "print_converted_proof" &&
    job.request.targetId === run.id &&
    job.request.targetVersionId === bundle.id
  );
}

function result(
  action: ConvertedProofAction,
  replayed: boolean,
): ConvertedProofResult {
  return {
    actionId: action.id,
    replayed,
    action: action.action,
    runRevision: action.resultRunRevision,
    gateRevision: action.resultGateRevision,
    runState: action.action === "approved" ? "deliverable" : "rejected",
  };
}

function normalizeNotes(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}
