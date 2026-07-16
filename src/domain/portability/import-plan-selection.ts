import type { BaseDocument } from "../repository/document-store.js";
import type {
  ValidatedImportBundle,
  ValidatedImportDocument,
} from "./import-validation.js";
import type { ImportPlanMode, ImportPlanRequest } from "./import-plan-model.js";
import type {
  PortabilityRegistry,
  PortabilityValidatedMediaFacts,
} from "./participants.js";

export interface ImportPlanSourceBundle extends ValidatedImportBundle {
  readonly root: {
    readonly projectId: string;
    readonly customerId: string;
    readonly familyId: string;
  };
}

export interface SelectedImportBundle {
  readonly documents: readonly ValidatedImportDocument[];
  readonly media: readonly PortabilityValidatedMediaFacts[];
}

const characterCollections = new Set([
  "customers",
  "families",
  "characters",
  "character_versions",
  "looks",
  "look_versions",
  "reference_photos",
  "assets",
  "original_assets",
]);

const templateCollections = new Set([
  "story_templates",
  "story_template_versions",
]);

export function selectImportBundle(input: {
  readonly request: ImportPlanRequest;
  readonly source: ImportPlanSourceBundle;
  readonly registry: PortabilityRegistry;
}): SelectedImportBundle {
  if (
    input.request.mode === "as_new_project" ||
    input.request.mode === "replace_existing"
  )
    return freezeSelection(input.source.documents, input.source.media);
  if (input.request.mode === "templates_only")
    return selectTemplates(input.request, input.source);
  return selectCharacters(input.request, input.source, input.registry);
}

export function sanitizeSelectedImportDocument(
  mode: ImportPlanMode,
  selectedIds: ReadonlySet<string>,
  collection: string,
  document: Readonly<BaseDocument>,
): BaseDocument {
  const result = clone(document);
  if (mode === "characters_only" && collection === "families") {
    const family = result as BaseDocument & {
      anchorCharacterId?: string | null;
    };
    if (
      family.anchorCharacterId &&
      !selectedIds.has(`characters:${family.anchorCharacterId}`)
    )
      family.anchorCharacterId = null;
  }
  return result;
}

function selectTemplates(
  request: ImportPlanRequest,
  source: ImportPlanSourceBundle,
): SelectedImportBundle {
  const selected = new Set(request.selectedTemplateIds);
  const templates = source.documents.filter(
    (item) =>
      item.collection === "story_templates" && selected.has(item.document.id),
  );
  if (templates.length !== selected.size)
    throw new Error("IMPORT_PLAN_TEMPLATE_SELECTION_INVALID");
  const documents = source.documents.filter((item) => {
    if (!templateCollections.has(item.collection)) return false;
    if (item.collection === "story_templates") return selected.has(item.id);
    return selected.has(stringField(item.document, "templateId"));
  });
  assertOnlyCollections(documents, templateCollections);
  return freezeSelection(documents, []);
}

function selectCharacters(
  request: ImportPlanRequest,
  source: ImportPlanSourceBundle,
  registry: PortabilityRegistry,
): SelectedImportBundle {
  const selectedCharacters = new Set(request.selectedCharacterIds);
  const byKey = new Map(
    source.documents.map((item) => [`${item.collection}:${item.id}`, item]),
  );
  const selectedKeys = new Set([
    `customers:${source.root.customerId}`,
    `families:${source.root.familyId}`,
    ...request.selectedCharacterIds.map((id) => `characters:${id}`),
  ]);
  for (const id of selectedCharacters) {
    const character = byKey.get(`characters:${id}`);
    if (
      !character ||
      stringField(character.document, "familyId") !== source.root.familyId
    )
      throw new Error("IMPORT_PLAN_CHARACTER_SELECTION_INVALID");
  }
  addCharacterDependents(source.documents, selectedCharacters, selectedKeys);
  closeCharacterMedia(byKey, selectedKeys, registry);
  const documents = source.documents.filter((item) =>
    selectedKeys.has(`${item.collection}:${item.id}`),
  );
  assertOnlyCollections(documents, characterCollections);
  const mediaKeys = selectedMediaKeys(documents, registry);
  const media = source.media.filter((item) =>
    mediaKeys.has(`${item.namespace}:${item.id}`),
  );
  if (media.length !== mediaKeys.size)
    throw new Error("IMPORT_PLAN_CHARACTER_MEDIA_CLOSURE_INVALID");
  return freezeSelection(documents, media);
}

function addCharacterDependents(
  documents: readonly ValidatedImportDocument[],
  characterIds: ReadonlySet<string>,
  selected: Set<string>,
): void {
  const lookIds = new Set<string>();
  for (const item of documents) {
    if (
      item.collection === "character_versions" &&
      characterIds.has(stringField(item.document, "characterId"))
    )
      selected.add(`character_versions:${item.id}`);
    if (
      item.collection === "looks" &&
      characterIds.has(stringField(item.document, "characterId"))
    ) {
      lookIds.add(item.id);
      selected.add(`looks:${item.id}`);
    }
  }
  for (const item of documents) {
    if (
      item.collection === "look_versions" &&
      lookIds.has(stringField(item.document, "lookId"))
    )
      selected.add(`look_versions:${item.id}`);
    if (
      item.collection === "reference_photos" &&
      referencePhotoSelected(item.document, characterIds, lookIds)
    )
      selected.add(`reference_photos:${item.id}`);
  }
}

function closeCharacterMedia(
  byKey: ReadonlyMap<string, ValidatedImportDocument>,
  selected: Set<string>,
  registry: PortabilityRegistry,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...selected]) {
      const item = byKey.get(key);
      if (!item) throw new Error("IMPORT_PLAN_CHARACTER_CLOSURE_INVALID");
      const participant = registry.forCollection(item.collection);
      const refs = [
        ...participant
          .assetReferences(item.document)
          .map((ref) => `assets:${ref.id}`),
        ...participant
          .originalReferences(item.document)
          .map((ref) => `original_assets:${ref.id}`),
      ];
      for (const ref of refs) {
        if (!byKey.has(ref))
          throw new Error("IMPORT_PLAN_CHARACTER_MEDIA_CLOSURE_INVALID");
        if (!selected.has(ref)) {
          selected.add(ref);
          changed = true;
        }
      }
    }
  }
}

function selectedMediaKeys(
  documents: readonly ValidatedImportDocument[],
  registry: PortabilityRegistry,
): Set<string> {
  const keys = new Set<string>();
  for (const item of documents) {
    const participant = registry.forCollection(item.collection);
    for (const ref of participant.assetReferences(item.document))
      keys.add(`asset:${ref.id}`);
    for (const ref of participant.originalReferences(item.document))
      keys.add(`original:${ref.id}`);
  }
  return keys;
}

function referencePhotoSelected(
  document: Readonly<BaseDocument>,
  characterIds: ReadonlySet<string>,
  lookIds: ReadonlySet<string>,
): boolean {
  const owner = (document as Readonly<Record<string, unknown>>).owner;
  if (!isRecord(owner)) return false;
  return (
    (typeof owner.characterId === "string" &&
      characterIds.has(owner.characterId)) ||
    (typeof owner.lookId === "string" && lookIds.has(owner.lookId))
  );
}

function assertOnlyCollections(
  documents: readonly ValidatedImportDocument[],
  allowed: ReadonlySet<string>,
): void {
  if (documents.some((item) => !allowed.has(item.collection)))
    throw new Error("IMPORT_PLAN_SELECTIVE_MODE_CONFUSION");
}

function freezeSelection(
  documents: readonly ValidatedImportDocument[],
  media: readonly PortabilityValidatedMediaFacts[],
): SelectedImportBundle {
  return Object.freeze({
    documents: Object.freeze([...documents]),
    media: Object.freeze([...media]),
  });
}

function stringField(document: Readonly<BaseDocument>, field: string): string {
  const value = (document as Readonly<Record<string, unknown>>)[field];
  return typeof value === "string" ? value : "";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
