import type { ZodType } from "zod";

import {
  jobEventSchema,
  jobRecordSchema,
  type JobRecord,
} from "../../jobs/schemas.js";
import {
  characterApprovalSchema,
  characterSheetIntentSchema,
  characterSheetSchema,
  creativeRunSchema,
  creativeStageRecordSchema,
  findingAcknowledgementSchema,
  illustrationVersionSchema,
  invalidationAuditSchema,
  layoutWorkRequestSchema,
  pagePromptVersionSchema,
  pageReviewSchema,
  pageSchema,
  pageTextVersionSchema,
} from "../creative/schemas.js";
import {
  bookApprovalActionSchema,
  bookApprovalCycleSchema,
  compositionProfileSchema,
  coverCompositionSchema,
  coverCompositionVersionSchema,
  layoutVersionSchema,
  pageLayoutHeadSchema,
  previewOutputSchema,
  previewWorkflowSchema,
} from "../layout/schemas.js";
import {
  convertedProofActionSchema,
  printerProfileSchema,
  printerProfileVersionSchema,
  printArtifactSchema,
  printPreflightReportSchema,
  printProofBundleSchema,
  printRunSchema,
} from "../print/schemas.js";
import type { BaseDocument } from "../repository/document-store.js";
import {
  definePortabilityParticipant,
  PARTICIPANT_PROJECT_JOB_TYPES,
  type PortabilityCatalogClaims,
  type PortabilityDocumentReference,
  type PortabilityMediaReference,
  type PortabilityParticipant,
  type PortabilityParticipantInput,
} from "./participants.js";

interface ReferencePath {
  collection: string;
  path: string;
  required?: boolean;
}

interface MediaPath {
  path: string;
  ownership: PortabilityMediaReference["ownership"];
}

interface ProductionSpec {
  key: string;
  schema: ZodType<BaseDocument>;
  version?: number;
  dependencies?: readonly string[];
  projectField?: string;
  customerField?: string;
  owner?: readonly ReferencePath[];
  refs?: readonly ReferencePath[];
  assets?: readonly MediaPath[];
  claims?: PortabilityCatalogClaims;
  extra?: Partial<PortabilityParticipantInput<BaseDocument>>;
}

const ref = (
  collection: string,
  path: string,
  required = true,
): ReferencePath => ({ collection, path, required });
const media = (
  path: string,
  ownership: PortabilityMediaReference["ownership"] = "referenced",
): MediaPath => ({ path, ownership });
const schema = (value: ZodType<unknown>) => value as ZodType<BaseDocument>;

const productionSpecs: readonly ProductionSpec[] = [
  {
    key: "jobs",
    schema: schema(jobRecordSchema),
    dependencies: ["projects"],
    projectField: "projectId",
    owner: [ref("projects", "projectId", false)],
    extra: { references: jobReferences },
    claims: {
      jobTypes: PARTICIPANT_PROJECT_JOB_TYPES,
      scopedWriters: ["jobs.job-record"],
    },
  },
  {
    key: "job_events",
    schema: schema(jobEventSchema),
    dependencies: ["jobs"],
    owner: [ref("jobs", "jobId")],
  },
  {
    key: "character_sheets",
    schema: schema(characterSheetSchema),
    dependencies: ["projects", "characters", "jobs"],
    projectField: "projectId",
    customerField: "customerId",
    owner: [ref("projects", "projectId")],
    refs: [
      ref("families", "familyId"),
      ref("characters", "characterId"),
      ref("character_versions", "characterVersionId"),
      ref("looks", "appearance.lookId", false),
      ref("look_versions", "appearance.lookVersionId", false),
      ref("reference_photos", "referenceLineage.referencePhotoIds.*", false),
      ref("character_sheets", "priorSheetId", false),
      ref("jobs", "generationJobIds.*"),
    ],
    assets: [
      media("views.*", "owned"),
      media("referenceThumbnailAssetIds.*"),
      media("pdfAssetId", "owned"),
    ],
    claims: { scopedWriters: ["creative.document"] },
  },
  {
    key: "character_sheet_intents",
    schema: schema(characterSheetIntentSchema),
    dependencies: ["projects", "characters", "jobs"],
    projectField: "projectId",
    customerField: "customerId",
    owner: [ref("projects", "projectId")],
    refs: [
      ref("character_sheets", "sheetId", false),
      ref("families", "familyId"),
      ref("characters", "characterId"),
      ref("character_versions", "characterVersionId"),
      ref("looks", "appearance.lookId", false),
      ref("look_versions", "appearance.lookVersionId", false),
      ref("reference_photos", "referencePhotoIds.*", false),
      ref("character_sheets", "priorSheetId", false),
      ref("jobs", "viewJobIds.*", false),
      ref("jobs", "finalizeJobId", false),
      ref("jobs", "approvalGateJobId", false),
    ],
    assets: [media("referenceThumbnailAssetIds.*")],
  },
  {
    key: "character_approvals",
    schema: schema(characterApprovalSchema),
    dependencies: ["projects", "character_sheets"],
    projectField: "projectId",
    owner: [ref("projects", "projectId")],
    refs: [
      ref("characters", "characterId"),
      ref("character_versions", "characterVersionId"),
      ref("character_sheets", "sheetId"),
      ref("change_events", "invalidatedByEventId", false),
    ],
  },
  {
    key: "creative_runs",
    schema: schema(creativeRunSchema),
    dependencies: ["projects", "jobs"],
    projectField: "projectId",
    owner: [ref("projects", "projectId")],
    refs: [
      ref("project_versions", "projectVersionId"),
      ref("story_versions", "inputStoryVersionId"),
      ref("story_versions", "outputStoryVersionId", false),
      ref("jobs", "nodes.*.jobId", false),
      ref("jobs", "internalReviewGateJobId", false),
    ],
  },
  {
    key: "creative_stage_records",
    schema: schema(creativeStageRecordSchema),
    dependencies: ["creative_runs", "jobs"],
    projectField: "projectId",
    owner: [ref("creative_runs", "runId")],
    refs: [ref("jobs", "jobId")],
    assets: [media("provenance.referenceAssetIds.*")],
  },
  {
    key: "pages",
    schema: schema(pageSchema),
    version: 2,
    dependencies: ["projects"],
    projectField: "projectId",
    owner: [ref("projects", "projectId")],
    refs: [
      ref("page_text_versions", "currentTextVersionId", false),
      ref("page_prompt_versions", "currentPromptVersionId", false),
      ref("illustration_versions", "currentIllustrationVersionId", false),
    ],
  },
  {
    key: "page_text_versions",
    schema: schema(pageTextVersionSchema),
    dependencies: ["pages"],
    owner: [ref("pages", "pageId")],
    refs: [
      ref("page_text_versions", "previousVersionId", false),
      ref("scene_versions", "sceneVersionId"),
      ref("characters", "dialogue.*.speakerCharacterId", false),
    ],
    extra: { references: pageTextReferences },
  },
  {
    key: "page_prompt_versions",
    schema: schema(pagePromptVersionSchema),
    dependencies: ["pages", "jobs"],
    owner: [ref("pages", "pageId")],
    refs: [
      ref("page_prompt_versions", "previousVersionId", false),
      ref("scene_versions", "sceneVersionId"),
      ref("jobs", "jobId"),
    ],
    assets: [media("provenance.referenceAssetIds.*")],
  },
  {
    key: "illustration_versions",
    schema: schema(illustrationVersionSchema),
    dependencies: ["pages", "page_prompt_versions"],
    owner: [ref("pages", "pageId")],
    refs: [
      ref("illustration_versions", "previousVersionId", false),
      ref("page_prompt_versions", "promptVersionId"),
    ],
    assets: [
      media("assetId", "owned"),
      media("provenance.referenceAssetIds.*"),
    ],
  },
  {
    key: "page_reviews",
    schema: schema(pageReviewSchema),
    dependencies: ["pages"],
    owner: [ref("pages", "pageId")],
    refs: [
      ref("page_text_versions", "textVersionId"),
      ref("illustration_versions", "illustrationVersionId"),
    ],
  },
  {
    key: "layout_work_requests",
    schema: schema(layoutWorkRequestSchema),
    dependencies: ["pages", "projects"],
    projectField: "projectId",
    owner: [ref("pages", "pageId")],
    refs: [
      ref("projects", "projectId"),
      ref("page_text_versions", "textVersionId"),
      ref("illustration_versions", "illustrationVersionId"),
    ],
  },
  {
    key: "finding_acknowledgements",
    schema: schema(findingAcknowledgementSchema),
    dependencies: ["creative_runs"],
    owner: [ref("creative_runs", "runId")],
  },
  {
    key: "invalidation_audits",
    schema: schema(invalidationAuditSchema),
    dependencies: ["change_events"],
    owner: [ref("change_events", "eventId")],
    projectField: "bookVersionProjectIds.*",
    extra: { references: invalidationAuditReferences },
  },
  {
    key: "composition_profiles",
    schema: schema(compositionProfileSchema),
    claims: { scopedWriters: ["layout.immutable-document"] },
  },
  {
    key: "page_layout_heads",
    schema: schema(pageLayoutHeadSchema),
    dependencies: ["pages"],
    owner: [ref("pages", "pageId")],
    refs: [ref("layout_versions", "currentLayoutVersionId")],
    claims: { scopedWriters: ["layout.revisioned-document"] },
  },
  {
    key: "layout_versions",
    schema: schema(layoutVersionSchema),
    dependencies: ["pages", "jobs"],
    owner: [ref("pages", "pageId")],
    refs: [
      ref("layout_versions", "previousVersionId", false),
      ref("composition_profiles", "inputSnapshot.compositionProfileId"),
      ref("project_versions", "inputSnapshot.projectVersionId"),
      ref("page_text_versions", "inputSnapshot.textVersionId", false),
      ref(
        "illustration_versions",
        "inputSnapshot.illustrationVersionId",
        false,
      ),
      ref("page_reviews", "inputSnapshot.pageReviewId", false),
      ref("layout_work_requests", "workRequestId", false),
      ref("jobs", "jobId"),
    ],
    assets: [media("inputSnapshot.sourceAssets.*.assetId")],
  },
  {
    key: "cover_compositions",
    schema: schema(coverCompositionSchema),
    dependencies: ["projects"],
    projectField: "projectId",
    owner: [ref("projects", "projectId")],
    refs: [ref("cover_composition_versions", "currentVersionId")],
  },
  {
    key: "cover_composition_versions",
    schema: schema(coverCompositionVersionSchema),
    dependencies: ["cover_compositions"],
    projectField: "projectId",
    owner: [ref("cover_compositions", "projectId")],
    refs: [
      ref("composition_profiles", "compositionProfileId"),
      ref("cover_composition_versions", "previousVersionId", false),
      ref("project_versions", "projectVersionId"),
    ],
    assets: [
      media("sourceAssets.*.assetId"),
      media("front.artworkAssetId"),
      media("back.artworkAssetId"),
    ],
  },
  {
    key: "preview_workflows",
    schema: schema(previewWorkflowSchema),
    dependencies: ["projects", "jobs"],
    projectField: "projectId",
    owner: [ref("projects", "projectId")],
    refs: [
      ref("jobs", "layoutJobIds.*", false),
      ref("jobs", "previewJobId", false),
      ref("preview_outputs", "currentPreviewOutputId", false),
    ],
  },
  {
    key: "preview_outputs",
    schema: schema(previewOutputSchema),
    dependencies: ["projects", "jobs"],
    projectField: "projectId",
    owner: [ref("projects", "projectId")],
    refs: [
      ref("jobs", "jobId"),
      ref("book_approval_cycles", "approvalCycleId"),
      ref("jobs", "approvalGateJobId"),
      ref("project_versions", "projectVersionId"),
      ref("composition_profiles", "compositionProfileId"),
      ref("cover_composition_versions", "coverCompositionVersionId"),
      ref("pages", "orderedInteriorPages.*.pageId"),
      ref("layout_versions", "orderedInteriorPages.*.layoutVersionId"),
      ref("page_text_versions", "orderedInteriorPages.*.textVersionId", false),
      ref(
        "illustration_versions",
        "orderedInteriorPages.*.illustrationVersionId",
        false,
      ),
      ref("page_reviews", "orderedInteriorPages.*.pageReviewId", false),
      ref("change_events", "invalidatedByEventIds.*", false),
    ],
    assets: [
      media("assetId", "owned"),
      media("orderedInteriorPages.*.sourceAssets.*.assetId"),
    ],
  },
  {
    key: "book_approval_cycles",
    schema: schema(bookApprovalCycleSchema),
    dependencies: ["projects", "preview_outputs", "jobs"],
    projectField: "projectId",
    owner: [ref("projects", "projectId")],
    refs: [
      ref("preview_outputs", "previewOutputId"),
      ref("jobs", "approvalGateJobId"),
      ref("cover_composition_versions", "coverCompositionVersionId"),
      ref("pages", "affectedScopes.*.pageId", false),
      ref("change_events", "invalidatedBy.eventId", false),
    ],
  },
  {
    key: "book_approval_actions",
    schema: schema(bookApprovalActionSchema),
    dependencies: ["book_approval_cycles", "jobs"],
    owner: [ref("book_approval_cycles", "cycleId")],
    refs: [
      ref("preview_outputs", "previewOutputId"),
      ref("jobs", "approvalGateJobId"),
      ref("book_approval_cycles", "expectedContentApprovalId", false),
      ref("book_approval_cycles", "result.currentContentApprovalId", false),
      ref("pages", "affectedScopes.*.pageId", false),
    ],
  },
  {
    key: "printer_profiles",
    schema: schema(printerProfileSchema),
    refs: [ref("printer_profile_versions", "currentVersionId")],
    claims: { scopedWriters: ["print.revisioned-document"] },
  },
  {
    key: "printer_profile_versions",
    schema: schema(printerProfileVersionSchema),
    dependencies: ["printer_profiles"],
    owner: [ref("printer_profiles", "profileId")],
    refs: [ref("printer_profile_versions", "previousVersionId", false)],
    assets: [media("color.iccAssetId"), media("coverTemplate.assetId")],
    claims: { scopedWriters: ["print.immutable-document"] },
  },
  {
    key: "print_runs",
    schema: schema(printRunSchema),
    dependencies: ["projects", "jobs", "printer_profiles"],
    projectField: "projectId",
    customerField: "customerId",
    owner: [ref("projects", "projectId")],
    refs: [
      ref("families", "familyId"),
      ref("book_approval_cycles", "approvalCycleId"),
      ref("jobs", "approvalGateJobId"),
      ref("preview_outputs", "previewOutputId"),
      ref("composition_profiles", "compositionProfileId"),
      ref("printer_profiles", "printerProfileId"),
      ref("printer_profile_versions", "printerProfileVersionId"),
      ref("jobs", "interiorJobId"),
      ref("jobs", "coverJobId"),
      ref("jobs", "preflightJobId", false),
      ref("jobs", "convertedProofGateJobId", false),
      ref("print_artifacts", "currentInteriorArtifactId", false),
      ref("print_artifacts", "currentCoverArtifactId", false),
      ref("print_preflight_reports", "currentPreflightReportId", false),
      ref("change_events", "invalidatedByEventIds.*", false),
    ],
    assets: [media("sourceAssets.*.assetId")],
  },
  {
    key: "print_artifacts",
    schema: schema(printArtifactSchema),
    dependencies: ["print_runs", "jobs"],
    projectField: "projectId",
    owner: [ref("print_runs", "runId")],
    refs: [
      ref("jobs", "jobId"),
      ref("printer_profile_versions", "printerProfileVersionId"),
      ref("print_artifacts", "reusedFromArtifactId", false),
    ],
    assets: [media("assetId", "owned")],
  },
  {
    key: "print_preflight_reports",
    schema: schema(printPreflightReportSchema),
    dependencies: ["print_runs"],
    projectField: "projectId",
    owner: [ref("print_runs", "runId")],
    refs: [
      ref("print_artifacts", "interiorArtifactId"),
      ref("print_artifacts", "coverArtifactId"),
      ref("printer_profile_versions", "printerProfileVersionId"),
      ref("pages", "measurements.pageMap.*.pageId", false),
    ],
    assets: [media("measurements.sourceAssets.*.assetId")],
  },
  {
    key: "print_proof_bundles",
    schema: schema(printProofBundleSchema),
    dependencies: ["print_runs", "jobs"],
    projectField: "projectId",
    owner: [ref("print_runs", "runId")],
    refs: [
      ref("jobs", "gateJobId"),
      ref("print_artifacts", "interiorArtifactId"),
      ref("print_artifacts", "coverArtifactId"),
    ],
    assets: [media("representativeAssets.*.assetId")],
  },
  {
    key: "converted_proof_actions",
    schema: schema(convertedProofActionSchema),
    dependencies: ["print_runs", "jobs"],
    customerField: "ownerCustomerId",
    owner: [ref("print_runs", "runId")],
    refs: [ref("jobs", "gateJobId")],
  },
];

export const productionPortabilityParticipants: readonly PortabilityParticipant[] =
  Object.freeze(productionSpecs.map(productionParticipant));

function productionParticipant(spec: ProductionSpec): PortabilityParticipant {
  return definePortabilityParticipant({
    key: spec.key,
    collection: spec.key,
    currentSchemaVersion: spec.version ?? 1,
    schema: spec.schema,
    dependencies: spec.dependencies,
    claims: spec.claims,
    ownerReferences: referencesFrom(spec.owner),
    references: referencesFrom(spec.refs),
    assetReferences: mediaFrom(spec.assets),
    projectIds: idsFrom(spec.projectField ?? "projectId"),
    customerIds: idsFrom(spec.customerField ?? "customerId"),
    selectForProject: (document, root) =>
      spec.projectField &&
      stringsAt(document, spec.projectField).includes(root.projectId)
        ? `owned_project:${root.projectId}`
        : null,
    selectForCustomer: (document, root) =>
      spec.customerField &&
      stringsAt(document, spec.customerField).includes(root.customerId)
        ? `owned_customer:${root.customerId}`
        : null,
    ...spec.extra,
  });
}

function referencesFrom(paths: readonly ReferencePath[] | undefined) {
  return (document: Readonly<BaseDocument>): PortabilityDocumentReference[] =>
    (paths ?? []).flatMap((path) =>
      stringsAt(document, path.path).map((id) => ({
        collection: path.collection,
        id,
        field: path.path,
        required: path.required,
      })),
    );
}

function mediaFrom(paths: readonly MediaPath[] | undefined) {
  return (document: Readonly<BaseDocument>): PortabilityMediaReference[] =>
    (paths ?? []).flatMap((path) =>
      stringsAt(document, path.path).map((id) => ({
        id,
        field: path.path,
        ownership: path.ownership,
      })),
    );
}

function idsFrom(path: string) {
  return (document: Readonly<BaseDocument>): readonly string[] =>
    stringsAt(document, path);
}

function stringsAt(document: Readonly<BaseDocument>, path: string): string[] {
  let values: unknown[] = [document];
  for (const segment of path.split("."))
    values = values.flatMap((value) => descend(value, segment));
  return values.filter(
    (value): value is string => typeof value === "string" && value !== "none",
  );
}

function descend(value: unknown, segment: string): unknown[] {
  if (segment === "*") {
    if (Array.isArray(value)) return value;
    if (isRecord(value)) return Object.values(value);
    return [];
  }
  return isRecord(value) ? [value[segment]] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const jobInputCollections: Readonly<Record<string, string>> = {
  projectId: "projects",
  projectVersion: "project_versions",
  storyVersion: "story_versions",
  sceneVersion: "scene_versions",
  page: "pages",
  pageId: "pages",
  textVersion: "page_text_versions",
  promptVersion: "page_prompt_versions",
  illustrationVersion: "illustration_versions",
  run: "creative_runs",
  runId: "print_runs",
  intent: "character_sheet_intents",
  sheet: "character_sheets",
  reviewFindings: "creative_stage_records",
  workRequestId: "layout_work_requests",
  coverVersionId: "cover_composition_versions",
  previewOutputId: "preview_outputs",
  approvalCycleId: "book_approval_cycles",
  printerProfileVersionId: "printer_profile_versions",
  reusedArtifactId: "print_artifacts",
  sourceRunId: "print_runs",
  proofBundleId: "print_proof_bundles",
  interiorArtifactId: "print_artifacts",
  coverArtifactId: "print_artifacts",
};

const resultCollections: Readonly<Record<string, readonly string[]>> = {
  character_sheet_view: ["assets"],
  character_sheet_finalize: [
    "character_sheets",
    "assets",
    "jobs",
    "character_sheet_intents",
  ],
  story_plan: ["creative_stage_records"],
  story_text: ["creative_stage_records"],
  scene_list: ["creative_stage_records"],
  page_prompt: ["creative_stage_records"],
  review_findings: ["creative_stage_records"],
  page_illustration: ["illustration_versions", "assets"],
  page_layout: ["layout_versions", "page_layout_heads", "preview_workflows"],
  preview_pdf: ["assets", "preview_outputs", "book_approval_cycles", "jobs"],
  print_interior: ["print_artifacts", "assets", "print_runs", "jobs"],
  print_cover: ["print_artifacts", "assets", "print_runs", "jobs"],
  print_interior_reuse: ["print_artifacts", "assets", "print_runs", "jobs"],
  print_preflight: [
    "print_runs",
    "print_preflight_reports",
    "print_proof_bundles",
    "jobs",
  ],
};

function jobReferences(
  document: Readonly<BaseDocument>,
): readonly PortabilityDocumentReference[] {
  const job = document as JobRecord;
  return [
    ...job.dependsOn.map((id) => jobRef(id, "dependsOn.*")),
    ...(job.supersedesJobId
      ? [jobRef(job.supersedesJobId, "supersedesJobId")]
      : []),
    ...job.successorJobIds.map((id) => jobRef(id, "successorJobIds.*")),
    ...jobInputReferences(job),
    ...jobResultReferences(job),
    ...jobGateReferences(job),
    ...jobTaskReferences(job),
  ];
}

function jobInputReferences(job: JobRecord): PortabilityDocumentReference[] {
  return Object.entries(job.inputSnapshot).flatMap(([field, id]) => {
    const collection = jobInputCollections[field];
    return collection
      ? [{ collection, id, field: `inputSnapshot.${field}`, required: false }]
      : [];
  });
}

function jobResultReferences(job: JobRecord): PortabilityDocumentReference[] {
  const collections = resultCollections[job.jobType] ?? [];
  return job.resultRefs.flatMap((id, index) => {
    const collection = collections[index];
    return collection
      ? [{ collection, id, field: `resultRefs.${index}`, required: false }]
      : [];
  });
}

function jobGateReferences(job: JobRecord): PortabilityDocumentReference[] {
  if (job.request.kind !== "human_gate") return [];
  const targets: Readonly<Record<string, readonly [string, string]>> = {
    character_approval: ["character_sheets", "character_sheets"],
    internal_review: ["creative_runs", "creative_runs"],
    customer_approval: ["projects", "preview_outputs"],
    print_converted_proof: ["print_runs", "print_proof_bundles"],
  };
  const collections = targets[job.request.gateKind];
  return collections
    ? [
        {
          collection: collections[0],
          id: job.request.targetId,
          field: "request.targetId",
        },
        {
          collection: collections[1],
          id: job.request.targetVersionId,
          field: "request.targetVersionId",
        },
      ]
    : [];
}

function jobTaskReferences(job: JobRecord): PortabilityDocumentReference[] {
  if (
    job.request.kind !== "text" &&
    job.request.kind !== "structured" &&
    job.request.kind !== "image"
  )
    return [];
  const request = job.request.request as unknown as Record<string, unknown>;
  return genericTaskReferences(request);
}

function genericTaskReferences(
  request: Record<string, unknown>,
): PortabilityDocumentReference[] {
  const refs: PortabilityDocumentReference[] = [];
  for (const id of stringsAt(
    request as unknown as BaseDocument,
    "task.participants.*.characterRef.characterId",
  ))
    refs.push({
      collection: "characters",
      id,
      field: "request.task.participants.*.characterRef.characterId",
    });
  for (const id of stringsAt(
    request as unknown as BaseDocument,
    "task.participants.*.characterRef.characterVersionId",
  ))
    refs.push({
      collection: "character_versions",
      id,
      field: "request.task.participants.*.characterRef.characterVersionId",
    });
  return refs;
}

function pageTextReferences(document: Readonly<BaseDocument>) {
  const base = referencesFrom([
    ref("page_text_versions", "previousVersionId", false),
    ref("scene_versions", "sceneVersionId"),
    ref("characters", "dialogue.*.speakerCharacterId", false),
  ])(document);
  return [...base, ...snapshotReferences(document, "inputSnapshot")];
}

function invalidationAuditReferences(document: Readonly<BaseDocument>) {
  return [
    ...stringsAt(document, "bookVersionProjectIds.*").map((id) => ({
      collection: "projects",
      id,
      field: "bookVersionProjectIds.*",
    })),
    ...stringsAt(document, "affectedIds.*").flatMap((id) =>
      [
        "pages",
        "illustration_versions",
        "layout_versions",
        "preview_outputs",
        "print_runs",
      ].map((collection) => ({
        collection,
        id,
        field: "affectedIds.*",
        required: false,
      })),
    ),
  ];
}

function snapshotReferences(document: Readonly<BaseDocument>, path: string) {
  const snapshot = valuesAt(document, path)[0];
  if (!isRecord(snapshot)) return [];
  return Object.entries(snapshot).flatMap(([field, id]) => {
    const collection = jobInputCollections[field];
    return collection && typeof id === "string"
      ? [{ collection, id, field: `${path}.${field}`, required: false }]
      : [];
  });
}

function valuesAt(document: Readonly<BaseDocument>, path: string): unknown[] {
  let values: unknown[] = [document];
  for (const segment of path.split("."))
    values = values.flatMap((value) => descend(value, segment));
  return values;
}

function jobRef(id: string, field: string): PortabilityDocumentReference {
  return { collection: "jobs", id, field };
}
