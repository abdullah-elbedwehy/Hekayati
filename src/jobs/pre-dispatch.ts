import type {
  ImageRequestDraft,
  ResolvedImageRequest,
  StructuredRequest,
  TextRequest,
} from "../providers/contract.js";
import { verifyCreativeCapacityPlan } from "../contracts/creative-policy.js";
import type {
  ExactCapabilityPort,
  ExactCapabilityTicket,
} from "./capabilities.js";
import { JobError } from "./errors.js";
import type { JobRecord, JobTarget } from "./schemas.js";

type Awaitable<T> = T | Promise<T>;

export interface CurrentInputGuard {
  assertCurrent(job: Readonly<JobRecord>): Awaitable<void>;
}

export interface GuardedReference {
  source: "reference_photo" | "approved_character_sheet";
  sourceRecordId: string;
  customerId: string;
  familyId: string;
  characterId: string;
  versionRefs: {
    characterVersionId: string;
    lookVersionId?: string;
  };
  selectedAssetId: string;
  provenanceAssetId: string;
  expectedSha256: string;
  mime: "image/jpeg" | "image/png";
}

export interface ImageReferenceResolver {
  inspect(
    draft: Readonly<ImageRequestDraft>,
  ): Promise<readonly GuardedReference[]>;
  load(
    draft: Readonly<ImageRequestDraft>,
    references: readonly GuardedReference[],
  ): Promise<ResolvedImageRequest>;
}

export interface PreparedDispatch {
  ticket: ExactCapabilityTicket;
  operation: JobTarget["operation"];
  request: TextRequest | StructuredRequest | ResolvedImageRequest;
}

export class PreDispatchCoordinator {
  constructor(
    private readonly capabilities: ExactCapabilityPort,
    private readonly imageReferences: ImageReferenceResolver,
  ) {}

  async prepare(
    job: Readonly<JobRecord>,
    guard: CurrentInputGuard,
    batchId: string,
  ): Promise<PreparedDispatch> {
    const target = assertRequestTarget(job);
    await guard.assertCurrent(job);
    const firstReferences =
      job.request.kind === "image"
        ? await this.imageReferences.inspect(job.request.request)
        : [];
    const ticket = await this.acquireTicket(
      job,
      target,
      batchId,
      firstReferences.length,
    );
    assertExactTicket(ticket, target, batchId);
    await guard.assertCurrent(job);
    if (job.request.kind === "image") {
      const currentReferences = await this.imageReferences.inspect(
        job.request.request,
      );
      return {
        ticket,
        operation: target.operation,
        request: await this.imageReferences.load(
          job.request.request,
          currentReferences,
        ),
      };
    }
    if (job.request.kind === "text" || job.request.kind === "structured") {
      return {
        ticket,
        operation: target.operation,
        request: job.request.request,
      };
    }
    throw new JobError("JOB_REQUEST_TARGET_MISMATCH");
  }

  private acquireTicket(
    job: Readonly<JobRecord>,
    target: JobTarget,
    batchId: string,
    referenceCount: number,
  ): Promise<ExactCapabilityTicket> {
    const isImage = job.request.kind === "image";
    const capacityAcknowledgement = isImage
      ? capacityAcknowledgementFor(job.request.request, target)
      : false;
    return this.capabilities.acquireExact({
      batchId,
      target,
      referenceCount,
      participantCount: isImage
        ? job.request.request.scene.participants.length
        : 0,
      ...(capacityAcknowledgement
        ? { reliableCharacterCountAcknowledged: true }
        : {}),
    });
  }
}

function capacityAcknowledgementFor(
  request: ImageRequestDraft,
  target: JobTarget,
): boolean {
  if (!request.capacityPlan) return false;
  try {
    return verifyCreativeCapacityPlan({
      plan: request.capacityPlan,
      target,
      referenceAssetIds: request.referenceImages.map((reference) =>
        reference.source === "reference_photo"
          ? reference.providerAssetId
          : reference.sheetAssetId,
      ),
      participantIds: request.scene.participants.map(
        (participant) => participant.characterRef.characterId,
      ),
    }).reliableCharacterCountAcknowledged;
  } catch (error) {
    throw new JobError("JOB_CAPACITY_PLAN_MISMATCH", 409, { cause: error });
  }
}

function assertRequestTarget(job: Readonly<JobRecord>): JobTarget {
  const target = job.target;
  if (!target) throw new JobError("JOB_TARGET_REQUIRED");
  const expected =
    job.request.kind === "text"
      ? "text"
      : job.request.kind === "structured"
        ? "structured"
        : job.request.kind === "image"
          ? "image"
          : null;
  if (expected === null || expected !== target.operation)
    throw new JobError("JOB_REQUEST_TARGET_MISMATCH");
  return target;
}

function assertExactTicket(
  ticket: ExactCapabilityTicket,
  target: JobTarget,
  batchId: string,
): void {
  if (
    ticket.batchId !== batchId ||
    ticket.providerId !== target.providerId ||
    ticket.modelId !== target.modelId ||
    ticket.operation !== target.operation ||
    ticket.settingsHash !== target.settingsHash
  )
    throw new JobError("JOB_CAPABILITY_TARGET_MISMATCH");
}
