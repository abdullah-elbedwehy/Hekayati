import { useState } from "react";

import type { AuthoringProjectWorkspace, MentionCandidate } from "../../types";

type Participant =
  AuthoringProjectWorkspace["version"]["storyConfig"]["participants"][number];

export function AppearanceOverridePanel({
  workspace,
  candidates,
  busy,
  onSave,
}: {
  workspace: AuthoringProjectWorkspace;
  candidates: MentionCandidate[];
  busy: boolean;
  onSave: (input: OverrideInput) => Promise<void>;
}) {
  const participants = workspace.version.storyConfig.participants;
  const [characterId, setCharacterId] = useState(
    participants[1]?.characterId ?? participants[0]?.characterId ?? "",
  );
  const [clothing, setClothing] = useState("");
  const [notes, setNotes] = useState("");
  const selectedId = participants.some(
    (item) => item.characterId === characterId,
  )
    ? characterId
    : (participants[0]?.characterId ?? "");
  const participant = participants.find(
    (item) => item.characterId === selectedId,
  );
  return (
    <section className="appearance-override" aria-labelledby="override-title">
      <OverrideHeading participant={participant} />
      <OverrideFields
        candidates={candidates}
        participants={participants}
        characterId={selectedId}
        clothing={clothing}
        notes={notes}
        setCharacterId={setCharacterId}
        setClothing={setClothing}
        setNotes={setNotes}
      />
      <OverrideSaveButton
        participant={participant}
        clothing={clothing}
        notes={notes}
        busy={busy}
        onSave={onSave}
      />
    </section>
  );
}

function OverrideSaveButton({
  participant,
  clothing,
  notes,
  busy,
  onSave,
}: {
  participant?: Participant;
  clothing: string;
  notes: string;
  busy: boolean;
  onSave: (input: OverrideInput) => Promise<void>;
}) {
  return (
    <button
      type="button"
      className="button button--secondary"
      disabled={busy || !participant}
      onClick={() =>
        participant && void onSave(overrideInput(participant, clothing, notes))
      }
    >
      حفظ تغيير لهذا المشروع فقط
    </button>
  );
}

function OverrideFields({
  candidates,
  participants,
  characterId,
  clothing,
  notes,
  setCharacterId,
  setClothing,
  setNotes,
}: {
  candidates: MentionCandidate[];
  participants: Participant[];
  characterId: string;
  clothing: string;
  notes: string;
  setCharacterId: (value: string) => void;
  setClothing: (value: string) => void;
  setNotes: (value: string) => void;
}) {
  return (
    <div className="form-grid form-grid--three">
      <CharacterField
        candidates={candidates}
        participants={participants}
        value={characterId}
        onChange={setCharacterId}
      />
      <label className="field">
        <span>ملابس هذا المشروع</span>
        <input
          name="projectClothing"
          value={clothing}
          onChange={(event) => setClothing(event.target.value)}
        />
      </label>
      <label className="field">
        <span>تفصيل مظهر إضافي</span>
        <input
          name="appearanceNotes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
    </div>
  );
}

function OverrideHeading({ participant }: { participant?: Participant }) {
  return (
    <header className="authoring-section-heading">
      <div>
        <p className="eyebrow">المظهر داخل هذا الكتاب</p>
        <h3 id="override-title">تغيير غير مشترك</h3>
      </div>
      <span className="plain-badge">
        {participant?.appearance.type === "project_override"
          ? "نسخة مشروع مستقلة"
          : "المكتبة الأصلية لن تتغير"}
      </span>
    </header>
  );
}

function CharacterField({
  candidates,
  participants,
  value,
  onChange,
}: {
  candidates: MentionCandidate[];
  participants: Participant[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>الشخصية</span>
      <select
        name="characterId"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {participants.map((participant) => (
          <option key={participant.characterId} value={participant.characterId}>
            {candidateName(candidates, participant.characterId)}
          </option>
        ))}
      </select>
    </label>
  );
}

function candidateName(candidates: MentionCandidate[], characterId: string) {
  return (
    candidates.find((item) => item.characterId === characterId)?.displayName ??
    "شخصية مثبتة"
  );
}

function overrideInput(
  participant: Participant,
  clothing: string,
  notes: string,
): OverrideInput {
  return {
    characterId: participant.characterId,
    expectedOverrideVersionId:
      participant.appearance.type === "project_override"
        ? participant.appearance.overrideVersionId
        : undefined,
    clothing,
    appearanceOverrides: notes ? { notes } : {},
  };
}

export interface OverrideInput {
  characterId: string;
  expectedOverrideVersionId?: string;
  clothing: string;
  appearanceOverrides: Record<string, string>;
}
