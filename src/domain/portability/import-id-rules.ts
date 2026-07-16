import type { BaseDocument } from "../repository/document-store.js";
import {
  rewriteParticipantDocumentIds,
  rewriteExplicitIdPath,
  valuesAtExplicitPath,
} from "./id-map.js";
import type {
  ExactIdMap,
  PortabilityDocumentReference,
  PortabilityMediaReference,
} from "./participants.js";

export interface ImportExplicitIdRule {
  readonly path: string;
  readonly namespace: string | null;
  readonly required?: boolean;
}

export interface ImportExplicitIdValue extends ImportExplicitIdRule {
  readonly sourceId: string;
}

export interface ImportIdentityAlias {
  readonly targetCollection: string;
  readonly targetPath: string;
}

export interface PortabilityParticipantIdRewriteInput<
  T extends BaseDocument = BaseDocument,
> {
  readonly collection: string;
  readonly document: Readonly<T>;
  readonly idMap: ExactIdMap;
  readonly ownerReferences: readonly PortabilityDocumentReference[];
  readonly references: readonly PortabilityDocumentReference[];
  readonly assetReferences: readonly PortabilityMediaReference[];
  readonly originalReferences: readonly PortabilityMediaReference[];
}

const provenanceRules = Object.freeze([
  rule("provenance.inputVersionRefs.*", null),
  rule("provenance.referenceAssetIds.*", "asset"),
]);

const capacityRules = Object.freeze([
  rule("policyPlan.capacity.participants.*.characterId", "characters"),
  rule("policyPlan.capacity.participants.*.requestedAssetIds.*", "asset"),
  rule("policyPlan.capacity.participants.*.selectedAssetIds.*", "asset"),
  rule("policyPlan.capacity.selectedAssetIds.*", "asset"),
]);

const requestCapacityRules = Object.freeze([
  rule("request.request.capacityPlan.participants.*.characterId", "characters"),
  rule(
    "request.request.capacityPlan.participants.*.requestedAssetIds.*",
    "asset",
  ),
  rule(
    "request.request.capacityPlan.participants.*.selectedAssetIds.*",
    "asset",
  ),
  rule("request.request.capacityPlan.selectedAssetIds.*", "asset"),
]);

const taskRules = Object.freeze([
  rule("request.request.task.inputVersionRefs.*", null),
  rule(
    "request.request.task.participants.*.characterRef.characterId",
    "characters",
  ),
  rule(
    "request.request.task.participants.*.characterRef.characterVersionId",
    "character_versions",
  ),
  rule("request.request.task.participants.*.availableLookIds.*", "looks"),
  rule(
    "request.request.task.payload.scene.participantRefs.*.characterId",
    "characters",
  ),
  rule(
    "request.request.task.payload.scene.participantRefs.*.characterVersionId",
    "character_versions",
  ),
  rule("request.request.task.payload.artifactRefs.*", null),
]);

const imageRequestRules = Object.freeze([
  rule(
    "request.request.scene.participants.*.characterRef.characterId",
    "characters",
  ),
  rule(
    "request.request.scene.participants.*.characterRef.characterVersionId",
    "character_versions",
  ),
  rule("request.request.scene.participants.*.lookId", "looks"),
  rule(
    "request.request.referenceImages.*.referencePhotoId",
    "reference_photos",
  ),
  rule(
    "request.request.referenceImages.*.characterSheetId",
    "character_sheets",
  ),
  rule("request.request.referenceImages.*.customerId", "customers"),
  rule("request.request.referenceImages.*.familyId", "families"),
  rule("request.request.referenceImages.*.characterId", "characters"),
  rule(
    "request.request.referenceImages.*.characterVersionId",
    "character_versions",
  ),
  rule(
    "request.request.referenceImages.*.owner.characterVersionId",
    "character_versions",
  ),
  rule("request.request.referenceImages.*.owner.lookId", "looks"),
  rule(
    "request.request.referenceImages.*.owner.lookVersionId",
    "look_versions",
  ),
  rule("request.request.referenceImages.*.appearance.lookId", "looks"),
  rule(
    "request.request.referenceImages.*.appearance.lookVersionId",
    "look_versions",
  ),
  rule("request.request.referenceImages.*.providerAssetId", "asset"),
  rule("request.request.referenceImages.*.sheetAssetId", "asset"),
]);

export const IMPORT_EXPLICIT_ID_RULES: Readonly<
  Record<string, readonly ImportExplicitIdRule[]>
> = Object.freeze({
  assets: provenanceRules,
  change_events: [
    rule("entityId", null),
    rule("fromVersionId", null),
    rule("toVersionId", null),
    rule("correlationId", "import_correlations"),
  ],
  character_sheets: [
    rule("provenanceByView.*.inputVersionRefs.*", null),
    rule("provenanceByView.*.referenceAssetIds.*", "asset"),
  ],
  character_sheet_intents: capacityRules,
  creative_runs: capacityRules,
  creative_stage_records: [
    ...provenanceRules,
    rule("output.value.characterArcs.*.characterRef.characterId", "characters"),
    rule(
      "output.value.characterArcs.*.characterRef.characterVersionId",
      "character_versions",
    ),
    rule("output.value.pages.*.dialogue.*.speaker.characterId", "characters"),
    rule(
      "output.value.pages.*.dialogue.*.speaker.characterVersionId",
      "character_versions",
    ),
    rule("output.value.scenes.*.participants.*.characterId", "characters"),
    rule(
      "output.value.scenes.*.participants.*.characterVersionId",
      "character_versions",
    ),
    rule(
      "output.value.scenes.*.perCharacter.*.characterRef.characterId",
      "characters",
    ),
    rule(
      "output.value.scenes.*.perCharacter.*.characterRef.characterVersionId",
      "character_versions",
    ),
    rule("output.value.scenes.*.perCharacter.*.lookId", "looks"),
    rule("output.value.referencePlan.*.characterRef.characterId", "characters"),
    rule(
      "output.value.referencePlan.*.characterRef.characterVersionId",
      "character_versions",
    ),
    rule("output.value.findings.*.refId", null, false),
  ],
  page_text_versions: [rule("inputSnapshot.*", null)],
  page_prompt_versions: provenanceRules,
  illustration_versions: [rule("inputSnapshot.*", null), ...provenanceRules],
  invalidation_audits: [rule("affectedIds.*", null, false)],
  layout_versions: [
    rule("inputSnapshot.textSources.*.entityId", null),
    rule("inputSnapshot.textSources.*.versionId", null),
    rule("bubbles.*.speakerCharacterId", "characters"),
  ],
  cover_composition_versions: [
    rule("textSources.*.entityId", null),
    rule("textSources.*.versionId", null),
  ],
  preview_outputs: [
    rule("orderedInteriorPages.*.textSources.*.entityId", null),
    rule("orderedInteriorPages.*.textSources.*.versionId", null),
  ],
  jobs: [
    rule("inputSnapshot.*", null),
    rule("resultRefs.*", null, false),
    ...provenanceRules,
    ...taskRules,
    ...imageRequestRules,
    ...requestCapacityRules,
  ],
});

const identityAliases: Readonly<Record<string, ImportIdentityAlias>> =
  Object.freeze({
    page_layout_heads: {
      targetCollection: "pages",
      targetPath: "pageId",
    },
    cover_compositions: {
      targetCollection: "projects",
      targetPath: "projectId",
    },
    preview_workflows: {
      targetCollection: "projects",
      targetPath: "projectId",
    },
  });

export function explicitImportIdValues(
  collection: string,
  document: Readonly<BaseDocument>,
): ImportExplicitIdValue[] {
  return rulesFor(collection).flatMap((item) =>
    valuesAtExplicitPath(document, item.path).map((sourceId) => ({
      ...item,
      sourceId,
    })),
  );
}

export function rewriteAdditionalParticipantIds<
  T extends BaseDocument = BaseDocument,
>(collection: string, document: Readonly<T>, idMap: ExactIdMap): T {
  const rewritten = clone(document) as T;
  for (const item of rulesFor(collection))
    rewriteExplicitIdPath(
      rewritten,
      item.path,
      idMap,
      item.namespace,
      item.required !== false,
    );
  return rewritten;
}

export function rewritePortabilityParticipantIds<
  T extends BaseDocument = BaseDocument,
>(input: PortabilityParticipantIdRewriteInput<T>): T {
  const declared = rewriteParticipantDocumentIds<T>({
    collection: input.collection,
    document: input.document,
    idMap: input.idMap,
    documentReferences: [...input.ownerReferences, ...input.references],
    assetReferences: input.assetReferences,
    originalReferences: input.originalReferences,
  });
  return rewriteAdditionalParticipantIds<T>(
    input.collection,
    declared,
    input.idMap,
  );
}

export function importIdentityAlias(
  collection: string,
): ImportIdentityAlias | null {
  return identityAliases[collection] ?? null;
}

function rulesFor(collection: string): readonly ImportExplicitIdRule[] {
  return IMPORT_EXPLICIT_ID_RULES[collection] ?? [];
}

function rule(
  path: string,
  namespace: string | null,
  required = true,
): ImportExplicitIdRule {
  return Object.freeze({ path, namespace, required });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
