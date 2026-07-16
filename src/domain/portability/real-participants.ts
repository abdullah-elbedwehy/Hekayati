import type { ZodType } from "zod";

import { assetRecordSchema } from "../../assets/asset-store.js";
import { originalAssetRecordSchema } from "../../assets/original-asset-store.js";
import {
  projectOverrideSchema,
  projectOverrideVersionSchema,
  projectSchema,
  projectVersionSchema,
  sceneSchema,
  sceneVersionSchema,
  storySchema,
  storyTemplateSchema,
  storyTemplateVersionSchema,
  storyVersionSchema,
} from "../authoring/schemas.js";
import {
  changeEventSchema,
  characterSchema,
  characterVersionSchema,
  customerSchema,
  familySchema,
  invalidationReceiptSchema,
  lookSchema,
  lookVersionSchema,
  referencePhotoSchema,
  type ChangeEvent,
} from "../library/schemas.js";
import type { BaseDocument } from "../repository/document-store.js";
import {
  definePortabilityParticipant,
  PARTICIPANT_ASSET_ROLES,
  type PortabilityCatalogClaims,
  type PortabilityDocumentReference,
  type PortabilityMediaReference,
  type PortabilityParticipant,
  type PortabilityParticipantInput,
  type PortabilityImportValidationContext,
} from "./participants.js";
import { productionPortabilityParticipants } from "./real-participants-production.js";
import { operationOwnershipParticipants } from "./real-participants-operations.js";
import { exportInternalOwnershipParticipants } from "./real-participants-export-internal.js";

interface ReferencePath {
  collection: string;
  path: string;
  required?: boolean;
}

interface MediaPath {
  path: string;
  ownership: PortabilityMediaReference["ownership"];
}

interface RealParticipantSpec {
  key: string;
  collection?: string;
  schema: ZodType<BaseDocument>;
  version?: number;
  dependencies?: readonly string[];
  projectField?: string;
  customerField?: string;
  projectRoot?: boolean;
  customerRoot?: boolean;
  familyRoot?: boolean;
  owner?: readonly ReferencePath[];
  refs?: readonly ReferencePath[];
  assets?: readonly MediaPath[];
  originals?: readonly MediaPath[];
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
const asDocumentSchema = (schema: ZodType<unknown>) =>
  schema as ZodType<BaseDocument>;

const mediaParticipantSpecs: readonly RealParticipantSpec[] = [
  {
    key: "assets",
    schema: asDocumentSchema(assetRecordSchema),
    refs: [ref("jobs", "provenance.jobId", false)],
    assets: [media("provenance.referencedAssetIds.*")],
    claims: {
      assetRoles: PARTICIPANT_ASSET_ROLES,
      scopedWriters: ["assets.asset-record"],
    },
    extra: {
      importValidationKey: "asset_bytes_and_kind:v1",
      validateImport: validateAssetImport,
    },
  },
  {
    key: "original_assets",
    schema: asDocumentSchema(originalAssetRecordSchema),
    claims: { scopedWriters: ["assets.original-asset-record"] },
    extra: {
      importValidationKey: "original_image_decode:v1",
      validateImport: validateOriginalImport,
    },
  },
];

const libraryParticipantSpecs: readonly RealParticipantSpec[] = [
  {
    key: "customers",
    schema: asDocumentSchema(customerSchema),
    customerRoot: true,
    claims: { scopedWriters: ["library.document"] },
  },
  {
    key: "families",
    schema: asDocumentSchema(familySchema),
    dependencies: ["customers"],
    customerField: "customerId",
    familyRoot: true,
    owner: [ref("customers", "customerId")],
    refs: [ref("characters", "anchorCharacterId", false)],
  },
  {
    key: "characters",
    schema: asDocumentSchema(characterSchema),
    dependencies: ["families"],
    owner: [ref("families", "familyId")],
    refs: [ref("character_versions", "currentVersionId")],
  },
  {
    key: "character_versions",
    schema: asDocumentSchema(characterVersionSchema),
    dependencies: ["characters"],
    owner: [ref("characters", "characterId")],
    refs: [
      ref("character_versions", "previousVersionId", false),
      ref("reference_photos", "profile.referencePhotoIds.*"),
    ],
  },
  {
    key: "looks",
    schema: asDocumentSchema(lookSchema),
    dependencies: ["characters"],
    owner: [ref("characters", "characterId")],
    refs: [ref("look_versions", "currentVersionId")],
  },
  {
    key: "look_versions",
    schema: asDocumentSchema(lookVersionSchema),
    dependencies: ["looks"],
    owner: [ref("looks", "lookId")],
    refs: [
      ref("look_versions", "previousVersionId", false),
      ref("reference_photos", "content.referencePhotoIds.*"),
    ],
  },
  {
    key: "reference_photos",
    schema: asDocumentSchema(referencePhotoSchema),
    dependencies: ["families", "characters"],
    customerField: "customerId",
    owner: [ref("families", "familyId")],
    refs: [
      ref("characters", "owner.characterId"),
      ref("looks", "owner.lookId", false),
      ref("reference_photos", "supersedesPhotoId", false),
    ],
    assets: [
      media("workingAssetId", "owned"),
      media("thumbnailAssetId", "owned"),
      media("providerAssetId", "owned"),
    ],
    originals: [media("originalAssetId", "owned")],
  },
  {
    key: "change_events",
    schema: asDocumentSchema(changeEventSchema),
    extra: {
      ownerReferences: changeEventOwnerReferences,
      references: changeEventVersionReferences,
    },
  },
  {
    key: "invalidation_receipts",
    schema: asDocumentSchema(invalidationReceiptSchema),
    dependencies: ["change_events"],
    owner: [ref("change_events", "eventId")],
    extra: { references: invalidationEvidenceReferences },
  },
];

const authoringParticipantSpecs: readonly RealParticipantSpec[] = [
  {
    key: "projects",
    schema: asDocumentSchema(projectSchema),
    version: 2,
    dependencies: ["customers", "families"],
    projectRoot: true,
    customerField: "customerId",
    refs: [
      ref("customers", "customerId"),
      ref("families", "familyId"),
      ref("project_versions", "currentVersionId"),
      ref("printer_profiles", "printerProfileId", false),
      ref("composition_profiles", "compositionProfileId"),
      ref(
        "cover_composition_versions",
        "currentCoverCompositionVersionId",
        false,
      ),
      ref("preview_outputs", "currentPreviewOutputId", false),
      ref("book_approval_cycles", "currentPreviewCycleId", false),
    ],
    claims: {
      scopedWriters: ["authoring.document", "authoring.project-revision"],
    },
  },
  {
    key: "project_versions",
    schema: asDocumentSchema(projectVersionSchema),
    dependencies: ["projects"],
    projectField: "projectId",
    owner: [ref("projects", "projectId")],
    refs: [
      ref("project_versions", "previousVersionId", false),
      ref("characters", "storyConfig.mainChildId"),
      ref("characters", "storyConfig.participants.*.characterId"),
      ref(
        "character_versions",
        "storyConfig.participants.*.characterVersionId",
      ),
      ref("looks", "storyConfig.participants.*.appearance.lookId", false),
      ref(
        "look_versions",
        "storyConfig.participants.*.appearance.lookVersionId",
        false,
      ),
      ref(
        "project_character_overrides",
        "storyConfig.participants.*.appearance.overrideId",
        false,
      ),
      ref(
        "project_character_override_versions",
        "storyConfig.participants.*.appearance.overrideVersionId",
        false,
      ),
      ref("story_templates", "storyConfig.templateId", false),
      ref("story_template_versions", "storyConfig.templateVersionId", false),
    ],
  },
  {
    key: "project_character_overrides",
    schema: asDocumentSchema(projectOverrideSchema),
    dependencies: ["projects", "characters"],
    projectField: "projectId",
    owner: [ref("projects", "projectId")],
    refs: [
      ref("characters", "characterId"),
      ref("project_character_override_versions", "currentVersionId"),
    ],
  },
  {
    key: "project_character_override_versions",
    schema: asDocumentSchema(projectOverrideVersionSchema),
    dependencies: ["project_character_overrides"],
    owner: [ref("project_character_overrides", "overrideId")],
    refs: [
      ref("project_character_override_versions", "previousVersionId", false),
      ref("character_versions", "baseCharacterVersionId"),
      ref("look_versions", "baseLookVersionId", false),
    ],
  },
  {
    key: "stories",
    schema: asDocumentSchema(storySchema),
    dependencies: ["projects"],
    projectField: "projectId",
    owner: [ref("projects", "projectId")],
    refs: [ref("story_versions", "currentVersionId")],
  },
  {
    key: "story_versions",
    schema: asDocumentSchema(storyVersionSchema),
    dependencies: ["stories"],
    owner: [ref("stories", "storyId")],
    refs: [
      ref("story_versions", "previousVersionId", false),
      ref("scene_versions", "sceneVersionIds.*"),
      ref(
        "scene_versions",
        "pageCountChange.operations.*.sourceSceneVersionIds.*",
        false,
      ),
    ],
  },
  {
    key: "scenes",
    schema: asDocumentSchema(sceneSchema),
    dependencies: ["projects"],
    projectField: "projectId",
    owner: [ref("projects", "projectId")],
    refs: [ref("scene_versions", "currentVersionId")],
  },
  {
    key: "scene_versions",
    schema: asDocumentSchema(sceneVersionSchema),
    dependencies: ["scenes"],
    owner: [ref("scenes", "sceneId")],
    refs: [
      ref("scene_versions", "previousVersionId", false),
      ref("scene_versions", "sourceSceneVersionIds.*", false),
      ref("characters", "content.documentSegments.*.characterId", false),
      ref("looks", "content.documentSegments.*.props.lookId", false),
      ref("characters", "content.dialogue.*.speakerCharacterId", false),
    ],
  },
  {
    key: "story_templates",
    schema: asDocumentSchema(storyTemplateSchema),
    refs: [ref("story_template_versions", "currentVersionId")],
    extra: { exportModes: ["templates_only"] },
  },
  {
    key: "story_template_versions",
    schema: asDocumentSchema(storyTemplateVersionSchema),
    dependencies: ["story_templates"],
    owner: [ref("story_templates", "templateId")],
    refs: [ref("story_template_versions", "previousVersionId", false)],
    extra: {
      exportModes: ["templates_only"],
      importValidationKey: "role_slot_template:v1",
      validateImport: validateRoleSlotTemplate,
    },
  },
];

export const realPortabilityParticipants: readonly PortabilityParticipant[] =
  Object.freeze([
    ...realParticipantSpecs().map(realParticipant),
    ...productionPortabilityParticipants,
    ...operationOwnershipParticipants,
    ...exportInternalOwnershipParticipants,
  ]);

function realParticipant(spec: RealParticipantSpec): PortabilityParticipant {
  const collection = spec.collection ?? spec.key;
  const common: PortabilityParticipantInput<BaseDocument> = {
    key: spec.key,
    collection,
    currentSchemaVersion: spec.version ?? 1,
    schema: spec.schema,
    dependencies: spec.dependencies,
    claims: spec.claims,
    ownerReferences: referencesFrom(spec.owner),
    references: referencesFrom(spec.refs),
    assetReferences: mediaFrom(spec.assets),
    originalReferences: mediaFrom(spec.originals),
    projectIds: idsFrom(spec.projectField ?? "projectId"),
    customerIds: idsFrom(spec.customerField ?? "customerId"),
    selectForProject: (document, root) => {
      if (spec.projectRoot && document.id === root.projectId)
        return `project_root:${root.projectId}`;
      if (spec.customerRoot && document.id === root.customerId)
        return `owning_customer:${root.customerId}`;
      if (spec.familyRoot && document.id === root.familyId)
        return `owning_family:${root.familyId}`;
      if (
        spec.projectField &&
        valueAt(document, spec.projectField) === root.projectId
      )
        return `owned_project:${root.projectId}`;
      return null;
    },
    selectForCustomer: (document, root) => {
      if (spec.customerRoot && document.id === root.customerId)
        return `customer_root:${root.customerId}`;
      if (
        spec.customerField &&
        valueAt(document, spec.customerField) === root.customerId
      )
        return `owned_customer:${root.customerId}`;
      return null;
    },
    ...spec.extra,
  };
  return definePortabilityParticipant(common);
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

function valueAt(document: Readonly<BaseDocument>, path: string): unknown {
  return valuesAt(document, path)[0];
}

function stringsAt(document: Readonly<BaseDocument>, path: string): string[] {
  return valuesAt(document, path).filter(
    (value): value is string =>
      typeof value === "string" && value !== "none" && value.length > 0,
  );
}

function valuesAt(document: Readonly<BaseDocument>, path: string): unknown[] {
  let values: unknown[] = [document];
  for (const segment of path.split(".")) {
    values = values.flatMap((value) => descend(value, segment));
  }
  return values.filter((value) => value !== null && value !== undefined);
}

function descend(value: unknown, segment: string): unknown[] {
  if (segment === "*") {
    if (Array.isArray(value)) return value;
    if (isRecord(value)) return Object.values(value);
    return [];
  }
  if (!isRecord(value)) return [];
  return [value[segment]];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateAssetImport(
  document: Readonly<BaseDocument>,
  context: PortabilityImportValidationContext,
): void {
  const asset = assetRecordSchema.parse(document);
  const facts = context.media("asset", asset.id);
  if (!facts) importFailure("PORTABILITY_IMPORT_ASSET_BYTES_MISSING");
  if (
    facts.bytes !== asset.bytes ||
    facts.sha256 !== asset.sha256 ||
    facts.mime !== asset.mime ||
    facts.extension !== asset.extension ||
    facts.role !== asset.role
  )
    importFailure("PORTABILITY_IMPORT_ASSET_METADATA_MISMATCH");
  if (asset.role === "icc_profile" && facts.inspection.kind !== "icc")
    importFailure("PORTABILITY_IMPORT_ICC_FACTS_INVALID");
  if (isPdfAsset(asset.mime) && facts.inspection.kind !== "pdf")
    importFailure("PORTABILITY_IMPORT_PDF_FACTS_INVALID");
  if (asset.mime.startsWith("image/") && facts.inspection.kind !== "image")
    importFailure("PORTABILITY_IMPORT_IMAGE_FACTS_INVALID");
}

function validateOriginalImport(
  document: Readonly<BaseDocument>,
  context: PortabilityImportValidationContext,
): void {
  const original = originalAssetRecordSchema.parse(document);
  const facts = context.media("original", original.id);
  if (!facts) importFailure("PORTABILITY_IMPORT_ORIGINAL_BYTES_MISSING");
  if (
    facts.bytes !== original.bytes ||
    facts.sha256 !== original.sha256 ||
    facts.mime !== original.sourceMime ||
    facts.extension !== original.extension ||
    facts.role !== "reference_photo" ||
    facts.inspection.kind !== "image"
  )
    importFailure("PORTABILITY_IMPORT_ORIGINAL_FACTS_INVALID");
}

function validateRoleSlotTemplate(document: Readonly<BaseDocument>): void {
  storyTemplateVersionSchema.parse(document);
}

function isPdfAsset(mime: string): boolean {
  return mime === "application/pdf";
}

function importFailure(code: string): never {
  throw new Error(code);
}

function realParticipantSpecs(): readonly RealParticipantSpec[] {
  return [
    ...mediaParticipantSpecs,
    ...libraryParticipantSpecs,
    ...authoringParticipantSpecs,
  ];
}

const changeEventCollections: Readonly<
  Partial<Record<ChangeEvent["entity"], [string, string?]>>
> = {
  character: ["characters", "character_versions"],
  look: ["looks", "look_versions"],
  project_override: [
    "project_character_overrides",
    "project_character_override_versions",
  ],
  scene: ["scenes", "scene_versions"],
  narrative_text: ["pages", "page_text_versions"],
  story: ["stories", "story_versions"],
  illustration: ["pages", "illustration_versions"],
  layout: ["pages", "layout_versions"],
  book_content: ["projects", "project_versions"],
  project_style: ["projects", "project_versions"],
  printer_profile: ["printer_profiles", "printer_profile_versions"],
  cover_template: ["printer_profiles", "printer_profile_versions"],
  template: ["story_templates", "story_template_versions"],
};

function changeEventOwnerReferences(
  document: Readonly<BaseDocument>,
): readonly PortabilityDocumentReference[] {
  const event = document as ChangeEvent;
  const collection = changeEventCollections[event.entity]?.[0];
  return collection
    ? [{ collection, id: event.entityId, field: "entityId", required: false }]
    : [];
}

function changeEventVersionReferences(
  document: Readonly<BaseDocument>,
): readonly PortabilityDocumentReference[] {
  const event = document as ChangeEvent;
  const collection = changeEventCollections[event.entity]?.[1];
  if (!collection) return [];
  return [event.fromVersionId, event.toVersionId].flatMap((id, index) =>
    id
      ? [
          {
            collection,
            id,
            field: index === 0 ? "fromVersionId" : "toVersionId",
            required: false,
          },
        ]
      : [],
  );
}

const invalidationEvidenceCollections = [
  "projects",
  "project_versions",
  "characters",
  "character_versions",
  "looks",
  "look_versions",
  "project_character_overrides",
  "project_character_override_versions",
  "stories",
  "story_versions",
  "scenes",
  "scene_versions",
  "pages",
  "page_text_versions",
  "page_prompt_versions",
  "illustration_versions",
  "layout_versions",
  "preview_outputs",
  "book_approval_cycles",
  "print_runs",
  "print_artifacts",
] as const;

function invalidationEvidenceReferences(
  document: Readonly<BaseDocument>,
): readonly PortabilityDocumentReference[] {
  return stringsAt(document, "affectedIds.*").flatMap((id) =>
    invalidationEvidenceCollections.map((collection) => ({
      collection,
      id,
      field: "affectedIds.*",
      required: false,
    })),
  );
}
