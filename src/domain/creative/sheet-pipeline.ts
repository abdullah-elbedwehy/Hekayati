import { ulid } from "ulid";

import type {
  AuthoringService,
  ProjectParticipant,
  ProjectWorkspace,
} from "../authoring/index.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { FamilyScope, LibraryService } from "../library/index.js";
import type { DocumentStore } from "../repository/document-store.js";
import type { SettingsService } from "../settings/settings.js";
import type { JobTarget } from "../../jobs/schemas.js";
import { createRequestHash } from "../../jobs/idempotency.js";
import type { JobScheduler } from "../../jobs/scheduler.js";
import type { JobRecord } from "../../jobs/schemas.js";
import {
  MANDATORY_IMAGE_CONSTRAINTS,
  neutralImageRequestDraftSchema,
  type NeutralProviderEligibleReference,
} from "../../contracts/creative-generation.js";
import { failCreative } from "./errors.js";
import {
  configuredCreativeLimits,
  prepareCreativePolicy,
  type CreativeCapabilityLimitsReader,
  type CreativePolicyConfirmations,
} from "./generation-policy.js";
import type { CreativeSheetService } from "./sheets.js";
import type {
  AppearanceBinding,
  CharacterSheetIntent,
  SheetViewName,
} from "./schemas.js";
import { selectedImageTarget } from "./targets.js";

const views = [
  "face",
  "front",
  "threeQuarter",
  "fullBody",
  "mainOutfit",
] as const satisfies readonly SheetViewName[];

const viewDirections: Record<SheetViewName, string> = {
  face: "لقطة وجه واضحة ومحايدة للشخصية وحدها",
  front: "منظر أمامي كامل وواضح للشخصية وحدها",
  threeQuarter: "منظر بزاوية ثلاثة أرباع للشخصية وحدها",
  fullBody: "الجسم كاملًا من الرأس للقدمين للشخصية وحدها",
  mainOutfit: "الملابس الرئيسية كاملة وواضحة للشخصية وحدها",
};

export interface CreativeSheetPipelineOptions {
  idFactory?: () => string;
  capacityLimits?: CreativeCapabilityLimitsReader;
}

type SheetReference = Extract<
  NeutralProviderEligibleReference,
  { source: "reference_photo" }
> & { thumbnailAssetId: string };

type SheetReferenceEntry = {
  photoId: string;
  owner:
    | { type: "character"; characterVersionId: string }
    | {
        type: "look";
        lookId: string;
        characterVersionId: string;
        lookVersionId: string;
      };
};

interface StartSheetInput {
  characterId: string;
  expectedProjectVersionId: string;
  priorSheetId?: string | null;
  revisionNotes?: string;
  priority?: number;
  confirmations?: CreativePolicyConfirmations;
}

export class CreativeSheetPipeline {
  private readonly authoringRepositories: AuthoringRepositories;
  private readonly idFactory: () => string;
  private readonly capacityLimits: CreativeCapabilityLimitsReader;
  private scheduler: JobScheduler | null = null;

  constructor(
    private readonly store: DocumentStore,
    private readonly library: LibraryService,
    private readonly authoring: AuthoringService,
    private readonly settings: SettingsService,
    private readonly sheets: CreativeSheetService,
    options: CreativeSheetPipelineOptions = {},
  ) {
    this.authoringRepositories = new AuthoringRepositories(store);
    this.idFactory = options.idFactory ?? ulid;
    this.capacityLimits = options.capacityLimits ?? configuredCreativeLimits;
  }

  bindScheduler(scheduler: JobScheduler): void {
    if (this.scheduler && this.scheduler !== scheduler)
      failCreative("CREATIVE_JOB_NOT_BOUND");
    this.scheduler = scheduler;
  }

  start(
    scope: FamilyScope,
    projectId: string,
    input: StartSheetInput,
  ): { intent: CharacterSheetIntent; jobs: JobRecord[] } {
    const scheduler = this.requireScheduler();
    return this.store.transaction(() =>
      this.startInTransaction(scope, projectId, input, scheduler),
    );
  }

  private startInTransaction(
    scope: FamilyScope,
    projectId: string,
    input: StartSheetInput,
    scheduler: JobScheduler,
  ): { intent: CharacterSheetIntent; jobs: JobRecord[] } {
    const subject = this.loadSheetSubject(scope, projectId, input);
    const prepared = this.prepareSheetPolicy(subject, input);
    const intent = this.createIntent(
      scope,
      projectId,
      subject.workspace,
      subject.participant,
      prepared.selected,
      subject.characterName,
      input,
      prepared.policy.plan,
    );
    const jobs = this.enqueueSheetJobs(
      scheduler,
      intent,
      subject.appearance,
      prepared.selected,
      prepared.policy.sanitizedPrompt,
      input.priority ?? 3,
      prepared.target,
    );
    this.markAwaitingApproval(projectId, jobs.intent.updatedAt);
    return {
      intent: jobs.intent,
      jobs: [...Object.values(jobs.views), jobs.finalize],
    };
  }

  private loadSheetSubject(
    scope: FamilyScope,
    projectId: string,
    input: StartSheetInput,
  ) {
    const workspace = this.authoring.getProjectWorkspace(scope, projectId);
    if (workspace.version.id !== input.expectedProjectVersionId)
      failCreative("CREATIVE_VERSION_CONFLICT");
    const participant = requireParticipant(workspace, input.characterId);
    const character = this.library.getCharacterVersion(
      scope,
      participant.characterId,
      participant.characterVersionId,
    );
    const appearance = appearanceBinding(participant.appearance);
    const references = sheetReferences(
      this.library,
      scope,
      participant.characterId,
      participant.characterVersionId,
      appearance,
    );
    if (references.length > 0)
      this.library.assertPhotoConsent(scope.customerId, "direct_photo");
    return {
      workspace,
      participant,
      appearance,
      references,
      characterName: character.profile.nickname || character.profile.name,
      promptText:
        character.profile.appearanceDescription || "هوية الشخصية المثبتة",
    };
  }

  private prepareSheetPolicy(
    subject: ReturnType<CreativeSheetPipeline["loadSheetSubject"]>,
    input: StartSheetInput,
  ) {
    const target = selectedImageTarget(this.settings);
    const policy = prepareCreativePolicy({
      target,
      limits: this.capacityLimits(target),
      styleId: subject.workspace.version.storyConfig.illustrationStyleId,
      promptText: [subject.promptText, input.revisionNotes ?? ""]
        .filter(Boolean)
        .join("\n"),
      participants: [
        {
          characterId: subject.participant.characterId,
          candidateAssetIds: subject.references.map(
            (item) => item.providerAssetId,
          ),
        },
      ],
      confirmations: input.confirmations,
    });
    const selected = subject.references.filter((reference) =>
      policy.plan.capacity.selectedAssetIds.includes(reference.providerAssetId),
    );
    return { target, policy, selected };
  }

  private createIntent(
    scope: FamilyScope,
    projectId: string,
    workspace: ProjectWorkspace,
    participant: ProjectParticipant,
    references: SheetReference[],
    characterName: string,
    input: StartSheetInput,
    policyPlan: CharacterSheetIntent["policyPlan"],
  ): CharacterSheetIntent {
    return this.sheets.createIntent({
      projectId,
      customerId: scope.customerId,
      familyId: scope.familyId,
      characterId: participant.characterId,
      characterVersionId: participant.characterVersionId,
      appearance: appearanceBinding(participant.appearance),
      characterName,
      styleId: workspace.version.storyConfig.illustrationStyleId,
      referencePhotoIds: references.map((item) => item.referencePhotoId),
      referenceThumbnailAssetIds: references.map(
        (item) => item.thumbnailAssetId,
      ),
      referenceLineage:
        references.length > 0 ? "photo_derived" : "description_only",
      revisionNotes: input.revisionNotes ?? "",
      priorSheetId: input.priorSheetId ?? null,
      policyPlan,
    });
  }

  private enqueueSheetJobs(
    scheduler: JobScheduler,
    intent: CharacterSheetIntent,
    appearance: AppearanceBinding,
    references: SheetReference[],
    appearanceDescription: string,
    priority: number,
    target: JobTarget,
  ) {
    const expectedRevision = intent.revision + 1;
    const viewJobs = Object.fromEntries(
      views.map((view) => [
        view,
        this.enqueueViewJob(
          scheduler,
          intent,
          appearance,
          references,
          appearanceDescription,
          view,
          priority,
          expectedRevision,
          target,
        ),
      ]),
    ) as Record<SheetViewName, JobRecord>;
    const finalize = this.enqueueFinalizeJob(
      scheduler,
      intent,
      appearance,
      viewJobs,
      priority,
      expectedRevision,
    );
    const bound = this.sheets.bindGenerationJobs({
      intentId: intent.id,
      expectedRevision: intent.revision,
      viewJobIds: viewJobIds(viewJobs),
      finalizeJobId: finalize.id,
    });
    return { intent: bound, views: viewJobs, finalize };
  }

  private enqueueViewJob(
    scheduler: JobScheduler,
    intent: CharacterSheetIntent,
    appearance: AppearanceBinding,
    references: SheetReference[],
    appearanceDescription: string,
    view: SheetViewName,
    priority: number,
    expectedRevision: number,
    target: JobTarget,
  ): JobRecord {
    return scheduler.enqueue({
      id: this.idFactory(),
      jobType: "character_sheet_view",
      projectId: intent.projectId,
      standaloneScopeId: null,
      dependsOn: [],
      priority,
      intentId: `${intent.id}-${view}`,
      target,
      request: {
        kind: "image",
        request: sheetImageRequest(
          intent,
          appearance,
          references,
          appearanceDescription,
          view,
          intent.policyPlan.capacity,
        ),
      },
      inputSnapshot: {
        intent: intent.id,
        intentRevision: `r${expectedRevision}`,
        characterVersion: intent.characterVersionId,
        ...(appearance.type === "shared_look"
          ? { lookVersion: appearance.lookVersionId }
          : {}),
        view,
      },
    });
  }

  private enqueueFinalizeJob(
    scheduler: JobScheduler,
    intent: CharacterSheetIntent,
    appearance: AppearanceBinding,
    viewJobs: Record<SheetViewName, JobRecord>,
    priority: number,
    expectedRevision: number,
  ): JobRecord {
    const descriptor = {
      intent: intent.id,
      sheet: intent.sheetId,
      viewJobs: viewJobIds(viewJobs),
    };
    return scheduler.enqueue({
      id: this.idFactory(),
      jobType: "character_sheet_finalize",
      projectId: intent.projectId,
      standaloneScopeId: null,
      dependsOn: views.map((view) => viewJobs[view].id),
      priority,
      intentId: `${intent.id}-finalize`,
      target: null,
      request: { kind: "local", payloadHash: createRequestHash(descriptor) },
      inputSnapshot: {
        intent: intent.id,
        intentRevision: `r${expectedRevision}`,
        characterVersion: intent.characterVersionId,
        ...(appearance.type === "shared_look"
          ? { lookVersion: appearance.lookVersionId }
          : {}),
      },
    });
  }

  private markAwaitingApproval(projectId: string, updatedAt: string): void {
    const project = this.authoringRepositories.projects.get(projectId);
    if (!project) failCreative("CREATIVE_SCOPE_MISMATCH");
    this.authoringRepositories.projects.update({
      ...project,
      status: "awaiting_character_approval",
      revision: project.revision + 1,
      updatedAt,
    });
  }

  requestChanges(
    scope: FamilyScope,
    projectId: string,
    input: {
      sheetId: string;
      expectedSheetRevision: number;
      intentId: string;
      expectedIntentRevision: number;
      gateJobId: string;
      expectedGateRevision: number;
      expectedProjectVersionId: string;
      notes: string;
      priority?: number;
      confirmations?: CreativePolicyConfirmations;
    },
  ) {
    return this.store.transaction(() => {
      const rejected = this.sheets.requestChanges(input);
      const successor = this.start(scope, projectId, {
        characterId: rejected.sheet.characterId,
        expectedProjectVersionId: input.expectedProjectVersionId,
        priorSheetId: rejected.sheet.id,
        revisionNotes: input.notes,
        priority: input.priority,
        confirmations: input.confirmations,
      });
      return { rejected, successor };
    });
  }

  private requireScheduler(): JobScheduler {
    if (!this.scheduler) failCreative("CREATIVE_JOB_NOT_BOUND");
    return this.scheduler;
  }
}

function appearanceBinding(
  selection:
    | { type: "base" }
    | { type: "shared_look"; lookId: string; lookVersionId: string }
    | {
        type: "project_override";
        overrideId: string;
        overrideVersionId: string;
      },
): AppearanceBinding {
  return selection.type === "shared_look"
    ? {
        type: "shared_look",
        lookId: selection.lookId,
        lookVersionId: selection.lookVersionId,
      }
    : { type: "base", lookId: null, lookVersionId: null };
}

function requireParticipant(
  workspace: ProjectWorkspace,
  characterId: string,
): ProjectParticipant {
  const participant = workspace.version.storyConfig.participants.find(
    (item) => item.characterId === characterId,
  );
  if (!participant) failCreative("CREATIVE_SCOPE_MISMATCH");
  return participant;
}

function viewJobIds(
  jobs: Record<SheetViewName, JobRecord>,
): Record<SheetViewName, string> {
  return Object.fromEntries(
    views.map((view) => [view, jobs[view].id]),
  ) as Record<SheetViewName, string>;
}

function sheetImageRequest(
  intent: CharacterSheetIntent,
  appearance: AppearanceBinding,
  references: SheetReference[],
  appearanceDescription: string,
  view: SheetViewName,
  capacityPlan: CharacterSheetIntent["policyPlan"]["capacity"],
) {
  return neutralImageRequestDraftSchema.parse({
    styleId: intent.styleId,
    capacityPlan,
    scene: {
      pageNumber: views.indexOf(view) + 1,
      description: sheetViewDescription(intent, appearanceDescription, view),
      participants: [
        {
          characterRef: {
            characterId: intent.characterId,
            characterVersionId: intent.characterVersionId,
          },
          action: "يقف بهدوء لورقة اعتماد الشخصية",
          emotion: "تعبير دافئ ومحايد",
          lookId: appearance.type === "shared_look" ? appearance.lookId : null,
        },
      ],
      environment: "خلفية استوديو بسيطة بلا عناصر أو أشخاص",
      composition: viewDirections[view],
      cameraFraming: viewDirections[view],
    },
    referenceImages: references.map(providerReference),
    negativeConstraints: [...MANDATORY_IMAGE_CONSTRAINTS],
    output: { minWidthPx: 1024, minHeightPx: 1024 },
  });
}

function sheetViewDescription(
  intent: CharacterSheetIntent,
  appearanceDescription: string,
  view: SheetViewName,
): string {
  const revision = intent.revisionNotes.trim()
    ? ` تعديل مطلوب: ${intent.revisionNotes.trim()}`
    : "";
  return `${appearanceDescription || "هوية الشخصية المثبتة"}. ${viewDirections[view]}.${revision}`;
}

function providerReference(reference: SheetReference) {
  return {
    source: reference.source,
    referencePhotoId: reference.referencePhotoId,
    customerId: reference.customerId,
    familyId: reference.familyId,
    characterId: reference.characterId,
    owner: reference.owner,
    providerAssetId: reference.providerAssetId,
  };
}

function sheetReferences(
  library: LibraryService,
  scope: FamilyScope,
  characterId: string,
  characterVersionId: string,
  appearance: AppearanceBinding,
) {
  const entries = sheetReferenceEntries(
    library,
    scope,
    characterId,
    characterVersionId,
    appearance,
  );
  return entries.map(({ photoId, owner }) => {
    const photo = library.getReferencePhoto(scope, photoId);
    if (!photo.providerAssetId) failCreative("CREATIVE_DEPENDENCY_INCOMPLETE");
    return {
      source: "reference_photo" as const,
      referencePhotoId: photo.id,
      customerId: scope.customerId,
      familyId: scope.familyId,
      characterId,
      owner,
      providerAssetId: photo.providerAssetId,
      thumbnailAssetId: photo.thumbnailAssetId,
    };
  });
}

function sheetReferenceEntries(
  library: LibraryService,
  scope: FamilyScope,
  characterId: string,
  characterVersionId: string,
  appearance: AppearanceBinding,
): SheetReferenceEntry[] {
  const characterVersion = library.getCharacterVersion(
    scope,
    characterId,
    characterVersionId,
  );
  const entries: SheetReferenceEntry[] =
    characterVersion.profile.referencePhotoIds.map((photoId) => ({
      photoId,
      owner: { type: "character", characterVersionId },
    }));
  if (appearance.type === "shared_look") {
    const look = library.getLookVersion(
      scope,
      characterId,
      appearance.lookId,
      appearance.lookVersionId,
    );
    entries.push(
      ...look.content.referencePhotoIds.map((photoId) => ({
        photoId,
        owner: {
          type: "look" as const,
          lookId: appearance.lookId,
          characterVersionId,
          lookVersionId: appearance.lookVersionId,
        },
      })),
    );
  }
  return entries;
}
