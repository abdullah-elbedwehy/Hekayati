import type { AssetStore } from "../../../src/assets/asset-store.js";
import { prepareCreativePolicy } from "../../../src/domain/creative/generation-policy.js";
import { CreativeRepositories } from "../../../src/domain/creative/repositories.js";
import { AuthoringRepositories } from "../../../src/domain/authoring/repositories.js";
import { hashCanonical } from "../../../src/domain/layout/hashes.js";
import type { DocumentStore } from "../../../src/domain/repository/document-store.js";
import type { JobScheduler } from "../../../src/jobs/scheduler.js";
import type { JobRecord } from "../../../src/jobs/types.js";
import {
  hash,
  neutralProvenance,
  portabilityFixtureAt,
  succeedLocalJob,
  syntheticPdf,
  waitingGate,
  type PortabilityFixtureScope,
} from "./support.js";

export async function seedCreativeEvidence(input: {
  store: DocumentStore;
  assets: AssetStore;
  scheduler: JobScheduler;
  scope: PortabilityFixtureScope;
  characterId: string;
  characterVersionId: string;
  referencePhotoId: string;
  thumbnailAssetId: string;
  projectVersionId: string;
  storyVersionId: string;
  nextId: () => string;
}) {
  const repositories = new CreativeRepositories(input.store);
  const policyPlan = prepareCreativePolicy({
    target: {
      providerId: "mock",
      modelId: "mock-portability-v1",
      operation: "image",
      settingsHash: hash("creative-settings"),
    },
    limits: { maxReferenceImages: 20, reliableCharacterCount: 20 },
    styleId: "modern_cartoon",
    promptText: "مشهد طفولي اصطناعي آمن",
    participants: [
      {
        characterId: input.characterId,
        candidateAssetIds: [input.thumbnailAssetId],
      },
    ],
  }).plan;
  const viewNames = [
    "face",
    "front",
    "threeQuarter",
    "fullBody",
    "mainOutfit",
  ] as const;
  const viewAssets = Object.fromEntries(
    await Promise.all(
      viewNames.map(async (view) => [
        view,
        await input.assets.put({
          bytes: Buffer.from(`synthetic-sheet-${view}`),
          extension: "png",
          mime: "image/png",
          role: "sheet_view",
          origin: "derived",
        }),
      ]),
    ),
  ) as Record<
    (typeof viewNames)[number],
    Awaited<ReturnType<AssetStore["put"]>>
  >;
  const sheetPdf = await input.assets.put({
    bytes: syntheticPdf("sheet"),
    extension: "pdf",
    mime: "application/pdf",
    role: "pdf_preview",
    origin: "derived",
  });
  const viewJobs = Object.fromEntries(
    viewNames.map((view) => [
      view,
      succeedLocalJob(input.scheduler, {
        jobType: "character_sheet_view",
        projectId: input.scope.projectId,
        intentId: `sheet-${view}`,
        resultRefs: [viewAssets[view].id],
      }),
    ]),
  ) as Record<(typeof viewNames)[number], JobRecord>;
  const sheetId = input.nextId();
  const finalize = succeedLocalJob(input.scheduler, {
    jobType: "character_sheet_finalize",
    projectId: input.scope.projectId,
    intentId: "sheet-finalize",
    dependsOn: viewNames.map((view) => viewJobs[view].id),
    resultRefs: [sheetId, sheetPdf.id],
  });
  const gate = waitingGate(input.scheduler, {
    jobType: "character_approval_gate",
    gateKind: "character_approval",
    projectId: input.scope.projectId,
    targetId: sheetId,
    targetVersionId: sheetId,
    intentId: "sheet-approval",
    dependsOn: [finalize.id],
  });
  input.scheduler.completeHumanGate(
    gate.id,
    { expectedRevision: gate.revision, targetVersionId: sheetId },
    () => true,
  );
  const common = {
    schemaVersion: 1 as const,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    revision: 0,
    projectId: input.scope.projectId,
    customerId: input.scope.customerId,
    familyId: input.scope.familyId,
    characterId: input.characterId,
    characterVersionId: input.characterVersionId,
    appearance: { type: "base" as const, lookId: null, lookVersionId: null },
    characterName: "نور النقل",
  };
  repositories.sheetIntents.insert({
    ...common,
    id: input.nextId(),
    sheetId,
    styleId: "modern_cartoon",
    referencePhotoIds: [input.referencePhotoId],
    referenceThumbnailAssetIds: [input.thumbnailAssetId],
    referenceLineage: "photo_derived",
    revisionNotes: "",
    status: "ready",
    priorSheetId: null,
    viewJobIds: Object.fromEntries(
      viewNames.map((view) => [view, viewJobs[view].id]),
    ) as Record<(typeof viewNames)[number], string>,
    finalizeJobId: finalize.id,
    approvalGateJobId: gate.id,
    policyPlan,
  });
  repositories.sheets.insert({
    ...common,
    id: sheetId,
    views: Object.fromEntries(
      viewNames.map((view) => [view, viewAssets[view].id]),
    ) as Record<(typeof viewNames)[number], string>,
    referenceThumbnailAssetIds: [input.thumbnailAssetId],
    referenceLineage: {
      source: "photo_derived",
      referencePhotoIds: [input.referencePhotoId],
    },
    pdfAssetId: sheetPdf.id,
    status: "approved",
    priorSheetId: null,
    generationJobIds: [
      ...viewNames.map((view) => viewJobs[view].id),
      finalize.id,
    ],
    provenanceByView: Object.fromEntries(
      viewNames.map((view) => [view, neutralProvenance()]),
    ),
  });
  repositories.approvals.insert({
    id: input.nextId(),
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    revision: 0,
    projectId: input.scope.projectId,
    characterId: input.characterId,
    characterVersionId: input.characterVersionId,
    sheetId,
    state: "approved",
    notes: "اعتماد اصطناعي",
    recordedAt: portabilityFixtureAt,
    invalidatedByEventId: null,
  });

  const runId = input.nextId();
  const storyPlanJob = succeedLocalJob(input.scheduler, {
    jobType: "story_plan",
    projectId: input.scope.projectId,
    intentId: "creative-story-plan",
    resultRefs: [runId],
  });
  repositories.runs.insert({
    id: runId,
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    revision: 0,
    projectId: input.scope.projectId,
    projectVersionId: input.projectVersionId,
    inputStoryVersionId: input.storyVersionId,
    outputStoryVersionId: input.storyVersionId,
    status: "complete",
    priority: 3,
    nodes: [
      {
        key: "story-plan",
        kind: "story_plan",
        pageNumber: null,
        dependsOnKeys: [],
        intentId: "creative-story-plan",
        jobId: storyPlanJob.id,
        state: "committed",
      },
    ],
    textTarget: {
      providerId: "mock",
      modelId: "mock-text-v1",
      operation: "structured",
      settingsHash: hash("text-settings"),
    },
    imageTarget: {
      providerId: "mock",
      modelId: "mock-image-v1",
      operation: "image",
      settingsHash: hash("image-settings"),
    },
    textTargetHash: hash("text-target"),
    imageTargetHash: hash("image-target"),
    policyPlan,
    internalReviewGateJobId: null,
  });
  const stageOutput = {
    kind: "story_plan" as const,
    value: {
      schemaVersion: 1 as const,
      title: "خطة نقل اصطناعية",
      logline: "نور تختبر رحلة قابلة للنقل بأمان.",
      arc: [{ beat: "البداية", purpose: "تقديم الرحلة", pagesEstimate: 2 }],
      settingSummary: "مكان اصطناعي آمن",
      characterArcs: [
        {
          characterRef: {
            characterId: input.characterId,
            characterVersionId: input.characterVersionId,
          },
          arcNote: "تتعلم الثقة",
        },
      ],
      hiddenGoalWeave: "يظهر الهدف من التصرفات.",
      toneNotes: "خفيف ودافئ",
      pageBudget: { storyPages: 12 },
    },
  };
  repositories.stages.insert({
    id: input.nextId(),
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    runId,
    projectId: input.scope.projectId,
    jobId: storyPlanJob.id,
    pageNumber: null,
    output: stageOutput,
    outputHash: hashCanonical(stageOutput),
    provenance: neutralProvenance(),
  });
  repositories.acknowledgements.insert({
    id: input.nextId(),
    schemaVersion: 1,
    createdAt: portabilityFixtureAt,
    updatedAt: portabilityFixtureAt,
    runId,
    findingKey: hash("finding"),
    note: "ملاحظة اصطناعية",
    acknowledgedAt: portabilityFixtureAt,
  });
  const event = new AuthoringRepositories(input.store).changeEvents.list()[0];
  if (event)
    repositories.invalidationAudits.insert({
      id: input.nextId(),
      schemaVersion: 1,
      createdAt: portabilityFixtureAt,
      updatedAt: portabilityFixtureAt,
      eventId: event.id,
      matrixRow: "IM-10",
      consequenceHash: hash("invalidation"),
      affectedIds: [input.scope.projectId],
      bookVersionProjectIds: [input.scope.projectId],
    });
  return { runId };
}
