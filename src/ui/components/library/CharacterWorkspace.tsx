import { useState, type FormEvent } from "react";

import type {
  ApiClient,
  CharacterVersionInput,
  LookInput,
  LookVersionInput,
} from "../../api";
import type {
  CharacterProfile,
  LibraryCharacter,
  LibraryLook,
  LibraryReferencePhoto,
} from "../../types";
import { CharacterProfileFields } from "./CharacterProfileFields";
import { EditorActions, EntityStatus, InlineNotice } from "./LibraryPrimitives";
import { LookForm, LooksPanel } from "./LooksPanel";
import { PhotoIntake } from "./PhotoIntake";
import { ReferencePhotoPanel } from "./ReferencePhotoPanel";
import { CharacterHistory } from "./VersionHistory";
import {
  libraryError,
  relationshipLabel,
  sourceModeLabel,
} from "./library-utils";

interface CharacterWorkspaceProps {
  client: ApiClient;
  character: LibraryCharacter;
  looks: LibraryLook[];
  referencePhotos: LibraryReferencePhoto[];
  anchorCharacterId?: string;
  onUpdate: (input: CharacterVersionInput) => Promise<void>;
  onVisibility: (action: "archive" | "restore") => Promise<void>;
  onCreateLook: (input: LookInput) => Promise<void>;
  onUpdateLook: (look: LibraryLook, input: LookVersionInput) => Promise<void>;
  onLookVisibility: (
    look: LibraryLook,
    action: "archive" | "restore",
  ) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function CharacterWorkspace(props: CharacterWorkspaceProps) {
  const [intent, setIntent] = useState<"none" | "update_base" | "new_look">(
    "none",
  );
  const [photo, setPhoto] = useState(false);
  return (
    <section
      className="character-workspace"
      aria-labelledby="character-heading"
    >
      <CharacterHeader {...props} />
      <ProfileSummary character={props.character} />
      <EditIntents intent={intent} setIntent={setIntent} />
      <CharacterEditArea
        {...props}
        intent={intent}
        onDone={() => setIntent("none")}
      />
      <CharacterPhotoSection {...props} open={photo} setOpen={setPhoto} />
      <ReferencePhotoPanel
        photos={props.referencePhotos.filter((item) => !item.lookId)}
        subjectName={props.character.currentVersion.profile.name}
      />
      <CharacterHistoryAndLooks {...props} />
    </section>
  );
}

function CharacterPhotoSection(
  props: CharacterWorkspaceProps & {
    open: boolean;
    setOpen: (value: boolean) => void;
  },
) {
  return (
    <>
      <div className="compact-actions">
        <button
          className="button button--secondary"
          type="button"
          onClick={() => props.setOpen(!props.open)}
        >
          {props.open ? "إغلاق إضافة الصورة" : "إضافة صورة مرجعية"}
        </button>
      </div>
      {props.open ? (
        <PhotoIntake
          client={props.client}
          familyId={props.character.familyId}
          owner={{ type: "character", characterId: props.character.id }}
          subjectName={props.character.currentVersion.profile.name}
          onComplete={async () => {
            await props.onRefresh();
            props.setOpen(false);
          }}
          onCancel={() => props.setOpen(false)}
        />
      ) : null}
    </>
  );
}

function CharacterHistoryAndLooks(props: CharacterWorkspaceProps) {
  return (
    <>
      <CharacterHistory
        client={props.client}
        character={props.character}
        onRevert={(profile) =>
          props.onUpdate({
            expectedVersionId: props.character.currentVersionId,
            intent: "update_base",
            profile,
          })
        }
      />
      <LooksPanel
        client={props.client}
        character={props.character}
        looks={props.looks}
        referencePhotos={props.referencePhotos.filter((item) => item.lookId)}
        onCreate={props.onCreateLook}
        onUpdate={props.onUpdateLook}
        onVisibility={props.onLookVisibility}
        onRefresh={props.onRefresh}
      />
    </>
  );
}

function CharacterEditArea(
  props: CharacterWorkspaceProps & {
    intent: "none" | "update_base" | "new_look";
    onDone: () => void;
  },
) {
  if (props.intent === "update_base")
    return (
      <CharacterEditForm
        character={props.character}
        anchorLocked={props.anchorCharacterId === props.character.id}
        onSave={props.onUpdate}
        onDone={props.onDone}
      />
    );
  if (props.intent === "new_look")
    return <LookForm onSave={props.onCreateLook} onDone={props.onDone} />;
  return null;
}

function CharacterHeader(props: CharacterWorkspaceProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const profile = props.character.currentVersion.profile;
  const archived = props.character.status === "archived";
  async function changeVisibility() {
    setBusy(true);
    setError("");
    try {
      await props.onVisibility(archived ? "restore" : "archive");
    } catch (reason) {
      setError(libraryError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="character-heading">
        <div>
          <p className="eyebrow">ملف بإصدارات ثابتة</p>
          <div className="workspace-title">
            <h3 id="character-heading" title={profile.name}>
              {profile.name}
            </h3>
            <EntityStatus status={props.character.status} />
          </div>
          <p>
            {relationshipLabel(profile.relationship)}،{" "}
            {sourceModeLabel(profile.sourceMode)}
          </p>
        </div>
        <button
          className="button button--quiet"
          type="button"
          disabled={busy}
          onClick={() => void changeVisibility()}
        >
          {archived ? "استعادة الشخصية" : "أرشفة الشخصية"}
        </button>
      </header>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    </>
  );
}

function ProfileSummary({ character }: { character: LibraryCharacter }) {
  const profile = character.currentVersion.profile;
  return (
    <div className="profile-summary">
      <dl>
        <div>
          <dt>العمر</dt>
          <dd>{profile.ageOrRange || "غير محدد"}</dd>
        </div>
        <div>
          <dt>الوصف</dt>
          <dd>{profile.appearanceDescription || "مرجع مصوّر فقط"}</dd>
        </div>
        <div>
          <dt>المراجع</dt>
          <dd>{profile.referencePhotoIds.length} مرجع</dd>
        </div>
        <div>
          <dt>الاهتمامات</dt>
          <dd>{profile.interests.join("، ") || "غير محددة"}</dd>
        </div>
      </dl>
      <InlineNotice tone="info">
        الهدف هو شبه معروف ومتسق يراجعه الإنسان. لا تعد حكايتي بتطابق رياضي
        دقيق.
      </InlineNotice>
    </div>
  );
}

function EditIntents(props: {
  intent: "none" | "update_base" | "new_look";
  setIntent: (intent: "none" | "update_base" | "new_look") => void;
}) {
  return (
    <fieldset className="edit-intents">
      <legend>وجهة التعديل</legend>
      <button
        className="intent-button"
        type="button"
        disabled
        aria-pressed={false}
        title="يتاح داخل المشروع بعد إضافة إدارة المشاريع"
      >
        <strong>لهذا المشروع فقط</strong>
        <span>غير متاح حتى مرحلة المشاريع</span>
      </button>
      <button
        className={`intent-button${props.intent === "update_base" ? " intent-button--selected" : ""}`}
        type="button"
        aria-pressed={props.intent === "update_base"}
        onClick={() =>
          props.setIntent(
            props.intent === "update_base" ? "none" : "update_base",
          )
        }
      >
        <strong>تحديث الملف الأساسي</strong>
        <span>ينشئ نسخة شخصية جديدة</span>
      </button>
      <button
        className={`intent-button${props.intent === "new_look" ? " intent-button--selected" : ""}`}
        type="button"
        aria-pressed={props.intent === "new_look"}
        onClick={() =>
          props.setIntent(props.intent === "new_look" ? "none" : "new_look")
        }
      >
        <strong>حفظ كمظهر جديد</strong>
        <span>يبقي الملف الأساسي كما هو</span>
      </button>
    </fieldset>
  );
}

function CharacterEditForm(props: {
  character: LibraryCharacter;
  anchorLocked: boolean;
  onSave: (input: CharacterVersionInput) => Promise<void>;
  onDone: () => void;
}) {
  const [profile, setProfile] = useState<CharacterProfile>(
    props.character.currentVersion.profile,
  );
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("saving");
    try {
      await props.onSave({
        expectedVersionId: props.character.currentVersionId,
        intent: "update_base",
        profile,
      });
      props.onDone();
    } catch (reason) {
      setError(libraryError(reason));
      setState("error");
    }
  }
  return (
    <form className="character-editor" onSubmit={(event) => void submit(event)}>
      <CharacterProfileFields
        profile={profile}
        setProfile={setProfile}
        relationshipLocked={props.anchorLocked}
      />
      <EditorActions
        state={state}
        error={error}
        primaryLabel="حفظ كنسخة أساسية جديدة"
        onCancel={props.onDone}
      />
    </form>
  );
}
