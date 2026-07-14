import { useState, type FormEvent } from "react";

import type { ApiClient, LookInput, LookVersionInput } from "../../api";
import type {
  LibraryCharacter,
  LibraryLook,
  LibraryReferencePhoto,
  LookVersion,
} from "../../types";
import {
  EditorActions,
  EntityStatus,
  FormMessage,
  InlineNotice,
} from "./LibraryPrimitives";
import { PhotoIntake } from "./PhotoIntake";
import { ReferencePhotoPanel } from "./ReferencePhotoPanel";
import { LookHistory } from "./VersionHistory";
import { libraryError } from "./library-utils";

interface LooksPanelProps {
  client: ApiClient;
  character: LibraryCharacter;
  looks: LibraryLook[];
  referencePhotos: LibraryReferencePhoto[];
  onCreate: (input: LookInput) => Promise<void>;
  onUpdate: (look: LibraryLook, input: LookVersionInput) => Promise<void>;
  onVisibility: (
    look: LibraryLook,
    action: "archive" | "restore",
  ) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function LooksPanel(props: LooksPanelProps) {
  const [creating, setCreating] = useState(false);
  return (
    <section className="library-subsection" aria-labelledby="looks-heading">
      <div className="library-subheading">
        <div>
          <p className="eyebrow">ملابس ومظهر قابل لإعادة الاستخدام</p>
          <h3 id="looks-heading">المظاهر</h3>
        </div>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => setCreating(!creating)}
        >
          {creating ? "إلغاء" : "إضافة مظهر"}
        </button>
      </div>
      <InlineNotice tone="info">
        المظهر المشترك ينشئ نسخًا مستقلة. حالة المشهد المؤقتة، مثل الدهشة، لا
        تُحفظ هنا.
      </InlineNotice>
      {creating ? (
        <LookForm onSave={props.onCreate} onDone={() => setCreating(false)} />
      ) : null}
      {props.looks.length === 0 ? (
        <p className="empty-copy">
          لا توجد مظاهر بعد. الملف الأساسي للشخصية لم يتغيّر.
        </p>
      ) : (
        <div className="look-list">
          {props.looks.map((look) => (
            <LookRow key={look.id} {...props} look={look} />
          ))}
        </div>
      )}
    </section>
  );
}

function LookRow(props: LooksPanelProps & { look: LibraryLook }) {
  const [editing, setEditing] = useState(false);
  const [photo, setPhoto] = useState(false);
  const version = props.look.currentVersion;
  return (
    <article className="look-row">
      <header>
        <div>
          <strong title={version.name}>{version.name}</strong>
          <span>{version.clothing || "لا يوجد وصف ملابس"}</span>
        </div>
        <EntityStatus status={props.look.status} />
      </header>
      <LookRowControls
        {...props}
        editing={editing}
        photo={photo}
        setEditing={setEditing}
        setPhoto={setPhoto}
      />
      {editing ? (
        <LookForm
          initial={version}
          onSave={(input) =>
            props.onUpdate(props.look, {
              ...input,
              expectedVersionId: props.look.currentVersionId,
            })
          }
          onDone={() => setEditing(false)}
        />
      ) : null}
      {photo ? <LookPhoto {...props} onDone={() => setPhoto(false)} /> : null}
      <ReferencePhotoPanel
        photos={props.referencePhotos.filter(
          (item) => item.lookId === props.look.id,
        )}
        subjectName={`${props.character.currentVersion.profile.name}، ${version.name}`}
      />
      <LookHistory
        client={props.client}
        look={props.look}
        onRevert={(old) =>
          props.onUpdate(props.look, toLookVersionInput(props.look, old))
        }
      />
    </article>
  );
}

function LookRowControls(
  props: LooksPanelProps & {
    look: LibraryLook;
    editing: boolean;
    photo: boolean;
    setEditing: (value: boolean) => void;
    setPhoto: (value: boolean) => void;
  },
) {
  return (
    <div className="compact-actions">
      <button
        className="button button--quiet"
        type="button"
        onClick={() => props.setEditing(!props.editing)}
      >
        {props.editing ? "إغلاق" : "تعديل المظهر"}
      </button>
      <button
        className="button button--quiet"
        type="button"
        onClick={() => props.setPhoto(!props.photo)}
      >
        {props.photo ? "إغلاق الصور" : "إضافة مرجع ملابس"}
      </button>
      <VisibilityAction look={props.look} onVisibility={props.onVisibility} />
    </div>
  );
}

function LookPhoto(
  props: LooksPanelProps & { look: LibraryLook; onDone: () => void },
) {
  return (
    <PhotoIntake
      client={props.client}
      familyId={props.character.familyId}
      owner={{
        type: "look",
        characterId: props.character.id,
        lookId: props.look.id,
      }}
      subjectName={`${props.character.currentVersion.profile.name}، ${props.look.currentVersion.name}`}
      onComplete={async () => {
        await props.onRefresh();
        props.onDone();
      }}
      onCancel={props.onDone}
    />
  );
}

function VisibilityAction(props: {
  look: LibraryLook;
  onVisibility: LooksPanelProps["onVisibility"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const archived = props.look.status === "archived";
  async function run() {
    setBusy(true);
    setError("");
    try {
      await props.onVisibility(props.look, archived ? "restore" : "archive");
    } catch (reason) {
      setError(libraryError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="visibility-action">
      <button
        className="button button--quiet"
        type="button"
        disabled={busy}
        onClick={() => void run()}
      >
        {archived ? "استعادة المظهر" : "أرشفة المظهر"}
      </button>
      <FormMessage state={error ? "error" : "idle"} error={error} />
    </div>
  );
}

export function LookForm(props: {
  initial?: LookVersion;
  onSave: (input: LookInput) => Promise<void>;
  onDone: () => void;
}) {
  const [name, setName] = useState(props.initial?.name ?? "");
  const [clothing, setClothing] = useState(props.initial?.clothing ?? "");
  const [overrides, setOverrides] = useState(
    formatOverrides(props.initial?.appearanceOverrides ?? {}),
  );
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("saving");
    try {
      await props.onSave({
        name: name.trim(),
        clothing: clothing.trim(),
        appearanceOverrides: parseOverrides(overrides),
        referencePhotoIds: props.initial?.referencePhotoIds ?? [],
      });
      props.onDone();
    } catch (reason) {
      setError(libraryError(reason));
      setState("error");
    }
  }
  return (
    <form className="inline-editor" onSubmit={(event) => void submit(event)}>
      <LookFields
        name={name}
        clothing={clothing}
        overrides={overrides}
        setName={setName}
        setClothing={setClothing}
        setOverrides={setOverrides}
      />
      <EditorActions
        state={state}
        error={error}
        primaryLabel="حفظ كنسخة جديدة"
      />
    </form>
  );
}

function LookFields(props: {
  name: string;
  clothing: string;
  overrides: string;
  setName: (value: string) => void;
  setClothing: (value: string) => void;
  setOverrides: (value: string) => void;
}) {
  return (
    <>
      <div className="form-grid">
        <label className="field">
          <span>اسم المظهر</span>
          <input
            required
            value={props.name}
            onChange={(event) => props.setName(event.target.value)}
            placeholder="مثال: بدلة الفضاء"
          />
        </label>
        <label className="field">
          <span>وصف الملابس</span>
          <input
            required
            value={props.clothing}
            onChange={(event) => props.setClothing(event.target.value)}
          />
        </label>
      </div>
      <label className="field">
        <span>تعديلات أخرى، سطر «الصفة: القيمة»</span>
        <textarea
          value={props.overrides}
          onChange={(event) => props.setOverrides(event.target.value)}
        />
      </label>
    </>
  );
}

function parseOverrides(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split("\n")
      .map((line) => line.split(":", 2).map((part) => part.trim()))
      .filter((parts) => parts.length === 2 && parts.every(Boolean)) as Array<
      [string, string]
    >,
  );
}

function formatOverrides(value: Record<string, string>): string {
  return Object.entries(value)
    .map(([key, entry]) => `${key}: ${entry}`)
    .join("\n");
}

function toLookVersionInput(
  look: LibraryLook,
  version: LookVersion,
): LookVersionInput {
  return {
    expectedVersionId: look.currentVersionId,
    name: version.name,
    clothing: version.clothing,
    appearanceOverrides: version.appearanceOverrides,
    referencePhotoIds: version.referencePhotoIds,
  };
}
