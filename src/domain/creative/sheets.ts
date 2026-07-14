import { isDeepStrictEqual } from "node:util";

import { ulid } from "ulid";

import type { AssetStore } from "../../assets/asset-store.js";
import type {
  ApprovedSheetLineageReader,
  ApprovedSheetReadResult,
} from "../../jobs/image-references.js";
import type { JobScheduler } from "../../jobs/scheduler.js";
import type { JobRecord } from "../../jobs/schemas.js";
import type {
  NeutralProviderEligibleReference as ProviderEligibleReference,
  NeutralProvenance as Provenance,
} from "../../contracts/creative-generation.js";
import {
  creativeCapacityBindingHash,
  creativePolicyPlanSchema,
  type CreativePolicyPlan,
} from "../../contracts/creative-policy.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failCreative } from "./errors.js";
import { CreativeRepositories } from "./repositories.js";
import {
  characterApprovalSchema,
  characterSheetIntentSchema,
  characterSheetSchema,
  type AppearanceBinding,
  type CharacterApproval,
  type CharacterSheet,
  type CharacterSheetIntent,
  type SheetViewName,
} from "./schemas.js";

type SheetReference = Extract<
  ProviderEligibleReference,
  { source: "approved_character_sheet" }
>;

const viewOrder = [
  "face",
  "front",
  "threeQuarter",
  "fullBody",
  "mainOutfit",
] as const satisfies readonly SheetViewName[];

export interface CreativeSheetServiceOptions {
  now?: () => string;
  idFactory?: () => string;
}

interface SheetChangeRequestInput {
  sheetId: string;
  expectedSheetRevision: number;
  intentId: string;
  expectedIntentRevision: number;
  gateJobId: string;
  expectedGateRevision: number;
  notes: string;
}

interface SheetDecisionResult {
  sheet: CharacterSheet;
  intent: CharacterSheetIntent;
  approval: CharacterApproval;
}

export class CreativeSheetService implements ApprovedSheetLineageReader {
  private readonly repositories: CreativeRepositories;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private scheduler: JobScheduler | null;

  constructor(
    private readonly store: DocumentStore,
    private readonly assets: AssetStore,
    scheduler: JobScheduler | null,
    options: CreativeSheetServiceOptions = {},
  ) {
    this.repositories = new CreativeRepositories(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.scheduler = scheduler;
  }

  bindScheduler(scheduler: JobScheduler): void {
    if (this.scheduler && this.scheduler !== scheduler)
      failCreative("CREATIVE_JOB_NOT_BOUND");
    this.scheduler = scheduler;
  }

  createIntent(input: {
    id?: string;
    sheetId?: string;
    projectId: string;
    customerId: string;
    familyId: string;
    characterId: string;
    characterVersionId: string;
    appearance: AppearanceBinding;
    characterName: string;
    styleId: "modern_cartoon" | "colorful_2d" | "soft_watercolor";
    referencePhotoIds: string[];
    referenceThumbnailAssetIds: string[];
    referenceLineage: "description_only" | "photo_derived";
    revisionNotes: string;
    priorSheetId: string | null;
    policyPlan?: CreativePolicyPlan;
  }): CharacterSheetIntent {
    const at = this.now();
    return this.repositories.sheetIntents.insert(
      characterSheetIntentSchema.parse({
        ...input,
        policyPlan: input.policyPlan ?? legacyPolicyPlan(input),
        id: input.id ?? this.idFactory(),
        sheetId: input.sheetId ?? this.idFactory(),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        revision: 0,
        status: "planned",
        viewJobIds: emptyViewJobs(),
        finalizeJobId: null,
        approvalGateJobId: null,
      }),
    );
  }

  bindGenerationJobs(input: {
    intentId: string;
    expectedRevision: number;
    viewJobIds: Record<SheetViewName, string>;
    finalizeJobId: string;
  }): CharacterSheetIntent {
    return this.store.transaction(() => {
      const intent = this.expectedIntent(
        input.intentId,
        input.expectedRevision,
      );
      if (intent.status !== "planned")
        failCreative("CREATIVE_RUN_STATE_INVALID");
      if (
        new Set([...Object.values(input.viewJobIds), input.finalizeJobId])
          .size !== 6
      )
        failCreative("CREATIVE_VERSION_CONFLICT");
      return this.updateIntent(intent, {
        status: "generating",
        viewJobIds: input.viewJobIds,
        finalizeJobId: input.finalizeJobId,
      });
    });
  }

  commitReadySheet(input: {
    intentId: string;
    expectedRevision: number;
    views: Record<SheetViewName, string>;
    pdfAssetId: string;
    provenanceByView: Partial<Record<SheetViewName, Provenance>>;
  }): { sheet: CharacterSheet; intent: CharacterSheetIntent } {
    return this.store.transaction(() => {
      const intent = this.expectedIntent(
        input.intentId,
        input.expectedRevision,
      );
      if (!["generating", "finalizing"].includes(intent.status))
        failCreative("CREATIVE_RUN_STATE_INVALID");
      const generationJobIds = generationJobs(intent);
      this.assertReadyAssets(input.views, input.pdfAssetId);
      const at = this.now();
      const sheet = this.repositories.sheets.insert(
        characterSheetSchema.parse({
          id: intent.sheetId,
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          revision: 0,
          projectId: intent.projectId,
          customerId: intent.customerId,
          familyId: intent.familyId,
          characterId: intent.characterId,
          characterVersionId: intent.characterVersionId,
          appearance: intent.appearance,
          characterName: intent.characterName,
          views: input.views,
          referenceThumbnailAssetIds: intent.referenceThumbnailAssetIds,
          referenceLineage: {
            source: intent.referenceLineage,
            referencePhotoIds: intent.referencePhotoIds,
          },
          pdfAssetId: input.pdfAssetId,
          status: "ready",
          priorSheetId: intent.priorSheetId,
          generationJobIds,
          provenanceByView: input.provenanceByView,
        }),
      );
      return {
        sheet,
        intent: this.updateIntent(intent, { status: "ready" }),
      };
    });
  }

  bindApprovalGate(input: {
    intentId: string;
    expectedRevision: number;
    gateJobId: string;
  }): CharacterSheetIntent {
    return this.store.transaction(() => {
      const intent = this.expectedIntent(
        input.intentId,
        input.expectedRevision,
      );
      const sheet = this.repositories.sheets.get(intent.sheetId);
      const gate = this.requireScheduler().get(input.gateJobId);
      if (!sheet || sheet.status !== "ready" || !gate)
        failCreative("CREATIVE_DEPENDENCY_INCOMPLETE");
      if (
        gate.request.kind !== "human_gate" ||
        gate.request.gateKind !== "character_approval" ||
        gate.request.targetId !== sheet.id ||
        gate.request.targetVersionId !== sheet.id
      )
        failCreative("CREATIVE_VERSION_CONFLICT");
      return this.updateIntent(intent, { approvalGateJobId: gate.id });
    });
  }

  approveSheet(input: {
    sheetId: string;
    expectedSheetRevision: number;
    intentId: string;
    expectedIntentRevision: number;
    gateJobId: string;
    expectedGateRevision: number;
    notes: string;
  }): {
    sheet: CharacterSheet;
    intent: CharacterSheetIntent;
    approval: CharacterApproval;
  } {
    let result:
      | {
          sheet: CharacterSheet;
          intent: CharacterSheetIntent;
          approval: CharacterApproval;
        }
      | undefined;
    this.requireScheduler().completeHumanGate(
      input.gateJobId,
      {
        expectedRevision: input.expectedGateRevision,
        targetVersionId: input.sheetId,
      },
      (job) => {
        result = this.approveSheetForGate(input, job.id);
        return Boolean(result);
      },
    );
    if (!result) failCreative("CREATIVE_APPROVAL_NOT_APPLICABLE");
    return result;
  }

  private approveSheetForGate(
    input: {
      sheetId: string;
      expectedSheetRevision: number;
      intentId: string;
      expectedIntentRevision: number;
      notes: string;
    },
    gateJobId: string,
  ) {
    const sheet = this.expectedSheet(
      input.sheetId,
      input.expectedSheetRevision,
    );
    const intent = this.expectedIntent(
      input.intentId,
      input.expectedIntentRevision,
    );
    if (
      sheet.status !== "ready" ||
      intent.sheetId !== sheet.id ||
      intent.approvalGateJobId !== gateJobId
    )
      return undefined;
    const at = this.now();
    const approval = this.repositories.approvals.insert(
      characterApprovalSchema.parse({
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        revision: 0,
        projectId: sheet.projectId,
        characterId: sheet.characterId,
        characterVersionId: sheet.characterVersionId,
        sheetId: sheet.id,
        state: "approved",
        notes: input.notes,
        recordedAt: at,
        invalidatedByEventId: null,
      }),
    );
    const approvedSheet = this.updateSheet(sheet, { status: "approved" });
    return { sheet: approvedSheet, intent, approval };
  }

  requestChanges(input: SheetChangeRequestInput): SheetDecisionResult {
    if (!input.notes.trim()) failCreative("CREATIVE_APPROVAL_NOT_APPLICABLE");
    return this.store.transaction(() => this.requestChangesForGate(input));
  }

  private requestChangesForGate(
    input: SheetChangeRequestInput,
  ): SheetDecisionResult {
    const sheet = this.expectedSheet(
      input.sheetId,
      input.expectedSheetRevision,
    );
    const intent = this.expectedIntent(
      input.intentId,
      input.expectedIntentRevision,
    );
    const gate = this.expectedChangeRequestGate(input, sheet, intent);
    this.requireScheduler().cancel(gate.id, {
      expectedRevision: gate.revision,
      expectedState: "waiting_review",
    });
    const approval = this.insertChangeRequestApproval(sheet, input.notes);
    return {
      sheet: this.updateSheet(sheet, { status: "revision_needed" }),
      intent: this.updateIntent(intent, { status: "rejected" }),
      approval,
    };
  }

  private expectedChangeRequestGate(
    input: SheetChangeRequestInput,
    sheet: CharacterSheet,
    intent: CharacterSheetIntent,
  ): JobRecord {
    const gate = this.requireScheduler().get(input.gateJobId);
    if (
      sheet.status !== "ready" ||
      intent.sheetId !== sheet.id ||
      intent.approvalGateJobId !== input.gateJobId ||
      !gate ||
      gate.revision !== input.expectedGateRevision ||
      gate.state !== "waiting_review" ||
      gate.request.kind !== "human_gate" ||
      gate.request.gateKind !== "character_approval" ||
      gate.request.targetId !== sheet.id ||
      gate.request.targetVersionId !== sheet.id
    )
      failCreative("CREATIVE_APPROVAL_NOT_APPLICABLE");
    return gate;
  }

  private insertChangeRequestApproval(
    sheet: CharacterSheet,
    notes: string,
  ): CharacterApproval {
    const at = this.now();
    return this.repositories.approvals.insert(
      characterApprovalSchema.parse({
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        revision: 0,
        projectId: sheet.projectId,
        characterId: sheet.characterId,
        characterVersionId: sheet.characterVersionId,
        sheetId: sheet.id,
        state: "changes_requested",
        notes,
        recordedAt: at,
        invalidatedByEventId: null,
      }),
    );
  }

  getSheet(sheetId: string): CharacterSheet {
    const sheet = this.repositories.sheets.get(sheetId);
    if (!sheet) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    return sheet;
  }

  getIntent(intentId: string): CharacterSheetIntent {
    const intent = this.repositories.sheetIntents.get(intentId);
    if (!intent) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    return intent;
  }

  assertJobCurrent(job: {
    id: string;
    jobType: string;
    inputSnapshot: Record<string, string>;
  }): void {
    const intentId = job.inputSnapshot.intent;
    if (!intentId) failCreative("CREATIVE_JOB_NOT_BOUND");
    const intent = this.getIntent(intentId);
    if (job.inputSnapshot.intentRevision !== `r${intent.revision}`)
      failCreative("CREATIVE_REVISION_CONFLICT");
    if (job.inputSnapshot.characterVersion !== intent.characterVersionId)
      failCreative("CREATIVE_VERSION_CONFLICT");
    if (
      intent.appearance.type === "shared_look" &&
      job.inputSnapshot.lookVersion !== intent.appearance.lookVersionId
    )
      failCreative("CREATIVE_VERSION_CONFLICT");
    if (job.jobType === "character_sheet_view") {
      const view = job.inputSnapshot.view as SheetViewName | undefined;
      if (!view || intent.viewJobIds[view] !== job.id)
        failCreative("CREATIVE_JOB_NOT_BOUND");
    } else if (
      job.jobType !== "character_sheet_finalize" ||
      intent.finalizeJobId !== job.id
    ) {
      failCreative("CREATIVE_JOB_NOT_BOUND");
    }
    if (intent.status !== "generating")
      failCreative("CREATIVE_RUN_STATE_INVALID");
  }

  listProjectSheets(projectId: string): CharacterSheet[] {
    return this.repositories.sheets.queryByField("projectId", projectId);
  }

  listProjectIntents(projectId: string): CharacterSheetIntent[] {
    return this.repositories.sheetIntents.queryByField("projectId", projectId);
  }

  resolveApprovedSheetReferenceMetadata(
    reference: Readonly<SheetReference>,
  ): ApprovedSheetReadResult {
    const sheet = this.repositories.sheets.get(reference.characterSheetId);
    if (!sheet) return { ok: false, code: "SHEET_NOT_FOUND" };
    if (sheet.status !== "approved")
      return { ok: false, code: "SHEET_NOT_APPROVED" };
    if (
      sheet.customerId !== reference.customerId ||
      sheet.familyId !== reference.familyId ||
      sheet.characterId !== reference.characterId ||
      sheet.characterVersionId !== reference.characterVersionId ||
      !isDeepStrictEqual(sheet.appearance, reference.appearance) ||
      !Object.values(sheet.views).includes(reference.sheetAssetId)
    )
      return { ok: false, code: "SHEET_REFERENCE_MISMATCH" };
    const asset = this.assets.get(reference.sheetAssetId);
    if (!asset || asset.role !== "sheet_view")
      return { ok: false, code: "SHEET_REFERENCE_MISMATCH" };
    const lineageValid =
      sheet.referenceLineage.source === "photo_derived"
        ? sheet.referenceLineage.referencePhotoIds.length > 0
        : sheet.referenceLineage.referencePhotoIds.length === 0;
    if (!lineageValid) return { ok: false, code: "SHEET_LINEAGE_INVALID" };
    return {
      ok: true,
      value: {
        characterSheetId: sheet.id,
        customerId: sheet.customerId,
        familyId: sheet.familyId,
        characterId: sheet.characterId,
        characterVersionId: sheet.characterVersionId,
        appearance: sheet.appearance,
        sheetAssetId: reference.sheetAssetId,
        lineageSource: sheet.referenceLineage.source,
      },
    };
  }

  private assertReadyAssets(
    views: Record<SheetViewName, string>,
    pdfAssetId: string,
  ): void {
    if (new Set(Object.values(views)).size !== viewOrder.length)
      failCreative("CREATIVE_VERSION_CONFLICT");
    for (const view of viewOrder) {
      const asset = this.assets.get(views[view]);
      if (!asset || asset.role !== "sheet_view")
        failCreative("CREATIVE_DEPENDENCY_INCOMPLETE");
    }
    const pdf = this.assets.get(pdfAssetId);
    if (!pdf || pdf.role !== "pdf_preview")
      failCreative("CREATIVE_DEPENDENCY_INCOMPLETE");
  }

  private expectedIntent(id: string, revision: number): CharacterSheetIntent {
    const intent = this.repositories.sheetIntents.get(id);
    if (!intent) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
    if (intent.revision !== revision)
      failCreative("CREATIVE_REVISION_CONFLICT");
    return intent;
  }

  private expectedSheet(id: string, revision: number): CharacterSheet {
    const sheet = this.getSheet(id);
    if (sheet.revision !== revision) failCreative("CREATIVE_REVISION_CONFLICT");
    return sheet;
  }

  private updateIntent(
    intent: CharacterSheetIntent,
    patch: Partial<CharacterSheetIntent>,
  ): CharacterSheetIntent {
    return this.repositories.sheetIntents.update(
      characterSheetIntentSchema.parse({
        ...intent,
        ...patch,
        revision: intent.revision + 1,
        updatedAt: this.now(),
      }),
    );
  }

  private updateSheet(
    sheet: CharacterSheet,
    patch: Partial<CharacterSheet>,
  ): CharacterSheet {
    return this.repositories.sheets.update(
      characterSheetSchema.parse({
        ...sheet,
        ...patch,
        revision: sheet.revision + 1,
        updatedAt: this.now(),
      }),
    );
  }

  private requireScheduler(): JobScheduler {
    if (!this.scheduler) failCreative("CREATIVE_JOB_NOT_BOUND");
    return this.scheduler;
  }
}

function legacyPolicyPlan(input: {
  characterId: string;
  referencePhotoIds: string[];
}): CreativePolicyPlan {
  const participant = {
    characterId: input.characterId,
    requestedAssetIds: [...input.referencePhotoIds],
    selectedAssetIds: [...input.referencePhotoIds],
  };
  const bound = {
    providerId: "mock" as const,
    modelId: "mock-image-v1",
    settingsHash: "0".repeat(64),
    maxReferenceImages: 20,
    reliableCharacterCount: 20,
    participants: [participant],
    selectedAssetIds: [...input.referencePhotoIds],
    reduced: false,
    participantExcess: false,
  };
  return creativePolicyPlanSchema.parse({
    prompt: {
      status: "allowed",
      policyVersion: "prompt-policy-v1",
      bindingHash: null,
      matchedCategories: [],
    },
    capacity: {
      ...bound,
      bindingHash: creativeCapacityBindingHash(bound),
      confirmed: false,
    },
  });
}

function generationJobs(intent: CharacterSheetIntent): string[] {
  const viewJobs = viewOrder.map((view) => intent.viewJobIds[view]);
  if (viewJobs.some((id) => id === null) || !intent.finalizeJobId)
    failCreative("CREATIVE_DEPENDENCY_INCOMPLETE");
  return [...(viewJobs as string[]), intent.finalizeJobId];
}

function emptyViewJobs(): Record<SheetViewName, null> {
  return {
    face: null,
    front: null,
    threeQuarter: null,
    fullBody: null,
    mainOutfit: null,
  };
}
