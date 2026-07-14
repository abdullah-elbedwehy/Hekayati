import type { Relationship } from "../library/schemas.js";
import { failAuthoring } from "./errors.js";
import type {
  AppearanceSelection,
  DocumentSegment,
  MentionProps,
} from "./schemas.js";

const TASHKEEL = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu;
const WHITESPACE = /\s+/gu;

type RelationshipType = Relationship["type"];

export interface CompileParticipant {
  characterId: string;
  characterVersionId: string;
  relationshipType: RelationshipType;
  narrativeRole: string;
  appearance: AppearanceSelection;
  ownedLookIds?: string[];
}

export type CompileCapability =
  | { mode: "mock_unlimited" }
  | { mode: "verified"; modelId: string; reliableReferenceCount: number }
  | { mode: "unavailable"; modelId: string; reason: string };

export interface CompileInput {
  segments: DocumentSegment[];
  participants: CompileParticipant[];
  mainChildId: string;
  selectedParticipantIds: string[];
  capability: CompileCapability;
  acknowledgements: { reconciliation: boolean; capacity: boolean };
}

export interface CompileOccurrence {
  characterId: string;
  characterVersionId: string;
  props: MentionProps;
  source: "mention" | "group";
}

export interface AuthoringCompileResult {
  participantIds: string[];
  occurrences: CompileOccurrence[];
  warnings: Array<{
    code: "PARTICIPANT_RECONCILIATION" | "PARTICIPANT_CAPACITY_EXCEEDED";
    characterIds: string[];
  }>;
  acknowledgements: CompileInput["acknowledgements"];
}

export interface MentionCandidate {
  characterId: string;
  displayName: string;
  relationshipType: RelationshipType;
  narrativeRole: string;
  thumbnailUrl: string | null;
  archived: boolean;
}

export function normalizeMentionSearch(value: string): string {
  return value
    .trim()
    .replace(WHITESPACE, " ")
    .normalize("NFC")
    .replace(TASHKEEL, "")
    .toLocaleLowerCase("und");
}

export function filterMentionCandidates(
  query: string,
  candidates: MentionCandidate[],
): MentionCandidate[] {
  const normalized = normalizeMentionSearch(query.replace(/^@/u, ""));
  if (!normalized) return candidates;
  return candidates.filter((candidate) =>
    normalizeMentionSearch(candidate.displayName).includes(normalized),
  );
}

export function degradeMentionToUnresolved(text: string): DocumentSegment {
  return { type: "unresolved", text: text.trim() || "@" };
}

export function compileAuthoringSegments(
  rawInput: CompileInput,
): AuthoringCompileResult {
  const input = normalizedCompileInput(rawInput);
  assertNoUnresolved(input.segments);
  const byId = new Map(
    input.participants.map((participant) => [
      participant.characterId,
      participant,
    ]),
  );
  const occurrences = input.segments.flatMap((segment) =>
    compileSegment(segment, input, byId),
  );
  const mentionedIds = unique(occurrences.map((item) => item.characterId));
  const warnings = reconciliationWarnings(
    mentionedIds,
    input.selectedParticipantIds,
    input.acknowledgements.reconciliation,
  );
  warnings.push(
    ...capacityWarnings(
      input.selectedParticipantIds,
      input.capability,
      input.acknowledgements.capacity,
    ),
  );
  return {
    participantIds: [...input.selectedParticipantIds],
    occurrences,
    warnings,
    acknowledgements: { ...input.acknowledgements },
  };
}

function normalizedCompileInput(input: CompileInput): CompileInput {
  const participantIds = input.participants.map((item) => item.characterId);
  const selected = unique(input.selectedParticipantIds);
  if (participantIds.length !== new Set(participantIds).size)
    failAuthoring("MENTION_CHARACTER_NOT_IN_PROJECT");
  if (selected.some((id) => !participantIds.includes(id)))
    failAuthoring("MENTION_CHARACTER_NOT_IN_PROJECT");
  return { ...input, selectedParticipantIds: selected };
}

function assertNoUnresolved(segments: DocumentSegment[]): void {
  const unresolved = segments.find((segment) => segment.type === "unresolved");
  if (unresolved)
    failAuthoring("MENTION_UNRESOLVED", { textLength: unresolved.text.length });
}

function compileSegment(
  segment: DocumentSegment,
  input: CompileInput,
  byId: Map<string, CompileParticipant>,
): CompileOccurrence[] {
  if (segment.type === "text" || segment.type === "unresolved") return [];
  if (segment.type === "mention") {
    const participant = byId.get(segment.characterId);
    if (!participant) failAuthoring("MENTION_CHARACTER_NOT_IN_PROJECT");
    assertLookOwned(participant, segment.props.lookId);
    return [occurrence(participant, segment.props, "mention")];
  }
  const members = expandGroup(segment.groupKey, input);
  if (members.length === 0)
    failAuthoring("MENTION_GROUP_EMPTY", { groupKey: segment.groupKey });
  const props = segment.props ?? emptyMentionProps();
  return members.map((participant) => occurrence(participant, props, "group"));
}

function expandGroup(
  groupKey: "hero" | "friends" | "family",
  input: CompileInput,
): CompileParticipant[] {
  if (groupKey === "hero")
    return input.participants.filter(
      (participant) => participant.characterId === input.mainChildId,
    );
  if (groupKey === "friends")
    return input.participants.filter(
      (participant) => participant.relationshipType === "friend",
    );
  const familyTypes: RelationshipType[] = [
    "main_child",
    "father",
    "mother",
    "brother",
    "sister",
    "grandfather",
    "grandmother",
  ];
  return input.participants.filter((participant) =>
    familyTypes.includes(participant.relationshipType),
  );
}

function assertLookOwned(
  participant: CompileParticipant,
  lookId: string | null,
): void {
  if (!lookId) return;
  const selectedLook =
    participant.appearance.type === "shared_look"
      ? participant.appearance.lookId
      : null;
  if (selectedLook !== lookId && !participant.ownedLookIds?.includes(lookId))
    failAuthoring("MENTION_LOOK_NOT_OWNED");
}

function occurrence(
  participant: CompileParticipant,
  props: MentionProps,
  source: CompileOccurrence["source"],
): CompileOccurrence {
  return {
    characterId: participant.characterId,
    characterVersionId: participant.characterVersionId,
    props: { ...props },
    source,
  };
}

function reconciliationWarnings(
  mentionedIds: string[],
  selectedIds: string[],
  acknowledged: boolean,
): AuthoringCompileResult["warnings"] {
  const mismatch = unique([
    ...mentionedIds.filter((id) => !selectedIds.includes(id)),
    ...selectedIds.filter((id) => !mentionedIds.includes(id)),
  ]);
  if (mismatch.length === 0) return [];
  if (!acknowledged)
    failAuthoring("PARTICIPANT_RECONCILIATION_REQUIRED", {
      characterIds: mismatch,
    });
  return [{ code: "PARTICIPANT_RECONCILIATION", characterIds: mismatch }];
}

function capacityWarnings(
  participantIds: string[],
  capability: CompileCapability,
  acknowledged: boolean,
): AuthoringCompileResult["warnings"] {
  if (capability.mode === "mock_unlimited") return [];
  if (capability.mode === "unavailable")
    failAuthoring("MODEL_CAPABILITY_UNAVAILABLE");
  if (participantIds.length <= capability.reliableReferenceCount) return [];
  if (!acknowledged)
    failAuthoring("PARTICIPANT_CAPACITY_CONFIRMATION_REQUIRED", {
      participantCount: participantIds.length,
      reliableReferenceCount: capability.reliableReferenceCount,
    });
  return [
    { code: "PARTICIPANT_CAPACITY_EXCEEDED", characterIds: participantIds },
  ];
}

function emptyMentionProps(): MentionProps {
  return {
    action: "",
    emotion: "",
    position: null,
    framing: null,
    lookId: null,
    heldObject: null,
    gazeTarget: null,
    speaks: false,
    dialogue: null,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
