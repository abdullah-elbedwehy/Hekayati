import { useState, type FormEvent } from "react";

import type {
  ApiClient,
  CharacterInput,
  CharacterVersionInput,
  FamilyInput,
  LookInput,
  LookVersionInput,
} from "../../api";
import type {
  LibraryCharacter,
  LibraryFamily,
  LibraryLook,
  LibraryReferencePhoto,
} from "../../types";
import { CharacterCreateForm } from "./CharacterCreateForm";
import { CharacterWorkspace } from "./CharacterWorkspace";
import { EntityStatus, InlineNotice } from "./LibraryPrimitives";
import { libraryError, relationshipLabel } from "./library-utils";

interface FamilyWorkspaceProps {
  client: ApiClient;
  family: LibraryFamily;
  characters: LibraryCharacter[];
  looks: LibraryLook[];
  referencePhotos: LibraryReferencePhoto[];
  selectedCharacterId?: string;
  onSelectCharacter: (id: string) => void;
  onFamilyVisibility: (action: "archive" | "restore") => Promise<void>;
  onUpdateFamily: (input: FamilyInput) => Promise<void>;
  onCreateCharacter: (input: CharacterInput) => Promise<void>;
  onUpdateCharacter: (
    character: LibraryCharacter,
    input: CharacterVersionInput,
  ) => Promise<void>;
  onCharacterVisibility: (
    character: LibraryCharacter,
    action: "archive" | "restore",
  ) => Promise<void>;
  onCreateLook: (
    character: LibraryCharacter,
    input: LookInput,
  ) => Promise<void>;
  onUpdateLook: (look: LibraryLook, input: LookVersionInput) => Promise<void>;
  onLookVisibility: (
    look: LibraryLook,
    action: "archive" | "restore",
  ) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function FamilyWorkspace(props: FamilyWorkspaceProps) {
  const [creating, setCreating] = useState(props.characters.length === 0);
  const [editing, setEditing] = useState(false);
  const { selected, anchor, blocked } = familyState(props);
  return (
    <section className="family-workspace" aria-labelledby="family-heading">
      <FamilyHeader
        {...props}
        creating={creating}
        setCreating={setCreating}
        blocked={blocked}
        editing={editing}
        setEditing={setEditing}
      />
      {editing ? (
        <FamilyEditForm
          family={props.family}
          onSave={props.onUpdateFamily}
          onDone={() => setEditing(false)}
        />
      ) : null}
      <AnchorState family={props.family} anchor={anchor} />
      <CharacterCreation
        {...props}
        visible={creating && !blocked}
        onClose={() => setCreating(false)}
      />
      <div className="character-layout">
        <CharacterList
          characters={props.characters}
          anchorId={props.family.anchorCharacterId}
          selectedId={selected?.id}
          onSelect={props.onSelectCharacter}
        />
        {selected ? (
          <CharacterDetail character={selected} {...props} />
        ) : (
          <CharacterEmpty />
        )}
      </div>
    </section>
  );
}

function familyState(props: FamilyWorkspaceProps) {
  const selected =
    props.characters.find((item) => item.id === props.selectedCharacterId) ??
    props.characters[0];
  const anchor = props.characters.find(
    (item) => item.id === props.family.anchorCharacterId,
  );
  const anchorMissing = Boolean(props.family.anchorCharacterId) && !anchor;
  const blocked =
    props.family.status === "archived" ||
    anchorMissing ||
    anchor?.status === "archived";
  return { selected, anchor, blocked };
}

function FamilyHeader(
  props: FamilyWorkspaceProps & {
    creating: boolean;
    setCreating: (value: boolean) => void;
    blocked: boolean;
    editing: boolean;
    setEditing: (value: boolean) => void;
  },
) {
  const visibility = useFamilyVisibility(props);
  return (
    <>
      <header className="workspace-heading family-heading">
        <div className="workspace-title">
          <div>
            <p className="eyebrow">حدود عائلية ثابتة</p>
            <h2 id="family-heading" title={props.family.name}>
              {props.family.name}
            </h2>
          </div>
          <EntityStatus status={props.family.status} />
        </div>
        <FamilyHeaderActions {...props} visibility={visibility} />
      </header>
      {visibility.error ? (
        <InlineNotice tone="error">{visibility.error}</InlineNotice>
      ) : null}
    </>
  );
}

function FamilyHeaderActions(
  props: Parameters<typeof FamilyHeader>[0] & {
    visibility: ReturnType<typeof useFamilyVisibility>;
  },
) {
  return (
    <div className="compact-actions">
      <button
        className="button button--quiet"
        type="button"
        onClick={() => props.setEditing(!props.editing)}
      >
        {props.editing ? "إغلاق تعديل الاسم" : "تعديل اسم العائلة"}
      </button>
      <button
        className="button button--secondary"
        type="button"
        disabled={props.blocked}
        onClick={() => props.setCreating(!props.creating)}
      >
        {props.creating ? "إغلاق الإضافة" : "إضافة شخصية"}
      </button>
      <button
        className="button button--quiet"
        type="button"
        disabled={props.visibility.busy}
        onClick={() => void props.visibility.run()}
      >
        {props.visibility.archived ? "استعادة العائلة" : "أرشفة العائلة"}
      </button>
    </div>
  );
}

function CharacterCreation(
  props: FamilyWorkspaceProps & { visible: boolean; onClose: () => void },
) {
  if (!props.visible) return null;
  return (
    <CharacterCreateForm
      client={props.client}
      family={props.family}
      onCreate={props.onCreateCharacter}
      onOpenExisting={props.onSelectCharacter}
      onRefresh={props.onRefresh}
      onClose={props.onClose}
    />
  );
}

function FamilyEditForm(props: {
  family: LibraryFamily;
  onSave: (input: FamilyInput) => Promise<void>;
  onDone: () => void;
}) {
  const [name, setName] = useState(props.family.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await props.onSave({ name: name.trim() });
      props.onDone();
    } catch (reason) {
      setError(libraryError(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="compact-form" onSubmit={(event) => void submit(event)}>
      <label className="field">
        <span>اسم العائلة</span>
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button className="button button--primary" disabled={saving}>
        حفظ الاسم
      </button>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    </form>
  );
}

function useFamilyVisibility(props: FamilyWorkspaceProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const archived = props.family.status === "archived";
  async function run() {
    setBusy(true);
    setError("");
    try {
      await props.onFamilyVisibility(archived ? "restore" : "archive");
    } catch (reason) {
      setError(libraryError(reason));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, archived, run };
}

function AnchorState(props: {
  family: LibraryFamily;
  anchor?: LibraryCharacter;
}) {
  if (!props.family.anchorCharacterId)
    return (
      <InlineNotice tone="warning">
        العائلة بلا طفل محور. أول شخصية يجب أن تكون الطفل المحور، ويُعيّن هذا
        الدور مرة واحدة.
      </InlineNotice>
    );
  if (!props.anchor)
    return (
      <InlineNotice tone="error">
        سجل الطفل محور العائلة غير متاح. لا يمكن إضافة أعضاء حتى إصلاح السجل.
      </InlineNotice>
    );
  if (props.anchor.status === "archived")
    return (
      <InlineNotice tone="warning">
        الطفل محور العائلة مؤرشف. استعد{" "}
        {props.anchor.currentVersion.profile.name} قبل إضافة عضو أو اختيار
        العائلة لمشروع لاحق.
      </InlineNotice>
    );
  return (
    <InlineNotice tone="success">
      الطفل محور العائلة:{" "}
      <strong>{props.anchor.currentVersion.profile.name}</strong>. العلاقات
      التالية تُقرأ بالنسبة إليه.
    </InlineNotice>
  );
}

function CharacterList(props: {
  characters: LibraryCharacter[];
  anchorId?: string;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="character-rail" aria-label="شخصيات العائلة">
      <h3>الشخصيات</h3>
      {props.characters.length === 0 ? (
        <p className="empty-copy">لم تُضف شخصية بعد.</p>
      ) : (
        <ul className="character-list">
          {props.characters.map((character) => (
            <li key={character.id}>
              <button
                className={
                  character.id === props.selectedId
                    ? "character-row character-row--selected"
                    : "character-row"
                }
                type="button"
                aria-pressed={character.id === props.selectedId}
                onClick={() => props.onSelect(character.id)}
              >
                <span>
                  <strong title={character.currentVersion.profile.name}>
                    {character.currentVersion.profile.name}
                  </strong>
                  <small>
                    {relationshipLabel(
                      character.currentVersion.profile.relationship,
                    )}
                    {character.id === props.anchorId ? "، محور العائلة" : ""}
                  </small>
                </span>
                <EntityStatus status={character.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function CharacterDetail(
  props: FamilyWorkspaceProps & { character: LibraryCharacter },
) {
  const looks = props.looks.filter(
    (look) => look.characterId === props.character.id,
  );
  const referencePhotos = props.referencePhotos.filter(
    (photo) => photo.characterId === props.character.id,
  );
  return (
    <CharacterWorkspace
      key={props.character.id}
      client={props.client}
      character={props.character}
      looks={looks}
      referencePhotos={referencePhotos}
      anchorCharacterId={props.family.anchorCharacterId}
      onUpdate={(input) => props.onUpdateCharacter(props.character, input)}
      onVisibility={(action) =>
        props.onCharacterVisibility(props.character, action)
      }
      onCreateLook={(input) => props.onCreateLook(props.character, input)}
      onUpdateLook={props.onUpdateLook}
      onLookVisibility={props.onLookVisibility}
      onRefresh={props.onRefresh}
    />
  );
}

function CharacterEmpty() {
  return (
    <div className="character-empty">
      <div className="empty-mark" aria-hidden="true">
        ح
      </div>
      <h3>ابنِ أول شخصية</h3>
      <p>
        يمكن البدء بوصف فقط، أو بصورة، أو بالاثنين معًا. الصور ليست مطلوبة لحفظ
        شخصية قابلة لإعادة الاستخدام.
      </p>
    </div>
  );
}
