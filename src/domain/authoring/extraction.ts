import {
  storyTemplateContentSchema,
  type ProjectParticipant,
  type StoryConfig,
  type StoryTemplateContent,
} from "./schemas.js";
import { failAuthoring } from "./errors.js";
import type { FamilyScope, LibraryService } from "../library/index.js";
import type { ProjectWorkspace } from "./project-service.js";

export interface CrossFamilyRoleSlot {
  slot: string;
  label: string;
  required: boolean;
  targetCharacterId: string | null;
}

export interface CrossFamilyDuplicationDraft {
  status: "role_remap_required" | "ready";
  templateContent: StoryTemplateContent;
  roleSlots: CrossFamilyRoleSlot[];
}

const forbiddenKeys = new Set([
  "customerId",
  "familyId",
  "characterId",
  "characterVersionId",
  "lookId",
  "lookVersionId",
  "overrideId",
  "overrideVersionId",
  "referencePhotoId",
  "originalAssetId",
  "workingAssetId",
  "providerAssetId",
  "thumbnailAssetId",
  "whatsapp",
  "dedicationText",
  "customNotes",
  "documentSegments",
]);

export function extractPrivacySafeTemplate(input: {
  name: string;
  participantCount: number;
  sourceMarkers: string[];
}): StoryTemplateContent {
  const content = storyTemplateContentSchema.parse({
    name: input.name,
    premise: "رحلة أصلية يتعاون فيها البطل مع المشاركين للوصول إلى حل آمن.",
    structure: [
      { key: "beginning", purpose: "حدث افتتاحي واضح واختيار أول للبطل." },
      { key: "discovery", purpose: "اكتشاف المشكلة وتجربة حل مناسب." },
      { key: "solution", purpose: "تعاون المشاركين واتخاذ القرار الأساسي." },
      { key: "ending", purpose: "نتيجة دافئة وعودة أو احتفال صغير." },
    ],
    environments: ["مكان البداية", "بيئة الاكتشاف", "مكان الحل"],
    roleSlots: extractionRoleSlots(input.participantCount),
    variables: [],
    possibleHiddenGoals: ["الثقة", "التعاون", "الشجاعة", "المسؤولية"],
    sceneGuidance: [
      "كل مشارك مربوط بدور، لا باسم شخص.",
      "تظل المشاهد آمنة ومفهومة بصريًا.",
    ],
    ageAdaptationRules: ageRules(),
    contentBoundaries: ["لا تُنسخ بيانات أو صور أو أسماء من المشروع المصدر."],
    endingPatterns: ["عودة دافئة.", "احتفال صغير.", "وداع مطمئن."],
  });
  assertPrivacySafeTemplate(content, input.sourceMarkers);
  return content;
}

export function assertPrivacySafeTemplate(
  content: StoryTemplateContent,
  sourceMarkers: string[],
): void {
  assertNoForbiddenKeys(content);
  const serialized = JSON.stringify(content)
    .normalize("NFC")
    .toLocaleLowerCase("und");
  const leaked = sourceMarkers
    .map((marker) => marker.trim().normalize("NFC").toLocaleLowerCase("und"))
    .filter((marker) => marker.length >= 2)
    .find((marker) => serialized.includes(marker));
  if (leaked) failAuthoring("PRIVACY_SCAN_FAILED");
}

export function createCrossFamilyDraft(
  templateContent: StoryTemplateContent,
): CrossFamilyDuplicationDraft {
  const roleSlots = templateContent.roleSlots.map((slot) => ({
    slot: slot.slot,
    label: slot.label,
    required: slot.required,
    targetCharacterId: null,
  }));
  return { status: "role_remap_required", templateContent, roleSlots };
}

export function mapCrossFamilyRole(
  draft: CrossFamilyDuplicationDraft,
  slot: string,
  targetCharacterId: string,
): CrossFamilyDuplicationDraft {
  const roleSlots = draft.roleSlots.map((item) =>
    item.slot === slot ? { ...item, targetCharacterId } : item,
  );
  const ready = roleSlots.every(
    (item) => !item.required || item.targetCharacterId !== null,
  );
  return {
    ...draft,
    roleSlots,
    status: ready ? "ready" : "role_remap_required",
  };
}

export function assertCrossFamilyDraftReady(
  draft: CrossFamilyDuplicationDraft,
): void {
  const missingSlots = draft.roleSlots
    .filter((item) => item.required && !item.targetCharacterId)
    .map((item) => item.slot);
  if (missingSlots.length)
    failAuthoring("CROSS_FAMILY_ROLE_REMAP_REQUIRED", { missingSlots });
}

export function missingCustomStoryFields(
  story: StoryConfig["customStory"],
): string[] {
  if (!story)
    return [
      "premise",
      "beginningBeat",
      "middleBeat",
      "endingBeat",
      "contentBoundaries",
    ];
  const fields: Array<keyof Omit<typeof story, "contentBoundaries">> = [
    "premise",
    "beginningBeat",
    "middleBeat",
    "endingBeat",
  ];
  const missing = fields.filter((field) => !story[field].trim());
  if (!story.contentBoundaries.some((item) => item.trim()))
    return [...missing, "contentBoundaries"];
  return missing;
}

export function sourcePrivacyMarkers(
  library: LibraryService,
  scope: FamilyScope,
  workspace: ProjectWorkspace,
): string[] {
  const identities = workspace.version.storyConfig.participants.flatMap(
    (participant) => participantPrivacyMarkers(library, scope, participant),
  );
  return [
    scope.customerId,
    scope.familyId,
    workspace.project.id,
    workspace.version.id,
    workspace.story.id,
    workspace.storyVersion.id,
    library.getCustomer(scope.customerId).whatsapp,
    ...workspace.scenes.flatMap(({ scene, version }) => [scene.id, version.id]),
    ...identities,
  ];
}

function extractionRoleSlots(count: number): StoryTemplateContent["roleSlots"] {
  const safeCount = Math.max(1, Math.min(20, count));
  return Array.from({ length: safeCount }, (_, index) =>
    index === 0
      ? {
          slot: "hero",
          label: "البطل",
          required: true,
          requiredRelationship: null,
          narrativeRole: "قائد الحكاية",
        }
      : {
          slot: `participant_${index + 1}`,
          label: `مشارك ${index + 1}`,
          required: false,
          requiredRelationship: null,
          narrativeRole: "مشارك في الحكاية",
        },
  );
}

function ageRules(): StoryTemplateContent["ageAdaptationRules"] {
  return [
    { ageBand: "age_3_5", guidance: "هدف واحد وجمل قصيرة وتكرار مطمئن." },
    { ageBand: "age_6_8", guidance: "سبب ونتيجة واضحان ومحاولتان مرتبتان." },
    { ageBand: "age_9_12", guidance: "اختيار له نتيجة ودوافع أعمق بلا وعظ." },
  ];
}

function participantPrivacyMarkers(
  library: LibraryService,
  scope: FamilyScope,
  participant: ProjectParticipant,
): string[] {
  const current = library.getCharacter(scope, participant.characterId);
  const pinned = library.getCharacterVersion(
    scope,
    participant.characterId,
    participant.characterVersionId,
  );
  const latest = library.getCharacterVersion(
    scope,
    current.id,
    current.currentVersionId,
  );
  return [
    participant.characterId,
    participant.characterVersionId,
    pinned.profile.name,
    pinned.profile.nickname ?? "",
    latest.profile.name,
    latest.profile.nickname ?? "",
    ...library
      .listReferencePhotosForCharacter(scope, participant.characterId)
      .map(({ id }) => id),
  ];
}

function assertNoForbiddenKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) failAuthoring("PRIVACY_SCAN_FAILED");
    assertNoForbiddenKeys(nested);
  }
}
