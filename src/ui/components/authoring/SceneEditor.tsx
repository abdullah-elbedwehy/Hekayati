import { useMemo, useState } from "react";

import { relationshipLabel } from "../library/library-utils";
import type {
  AuthoringProjectWorkspace,
  AuthoringSceneContent,
  MentionCandidate,
} from "../../types";

type SceneRecord = AuthoringProjectWorkspace["scenes"][number];

export function SceneEditor({
  scene,
  candidates,
  busy,
  onSave,
}: {
  scene: SceneRecord;
  candidates: MentionCandidate[];
  busy: boolean;
  onSave: (content: AuthoringSceneContent) => Promise<void>;
}) {
  const [content, setContent] = useState(scene.version.content);
  const mentions = useMemo(
    () => content.documentSegments.filter((item) => item.type === "mention"),
    [content.documentSegments],
  );
  return (
    <section className="scene-editor" aria-labelledby="scene-editor-title">
      <SceneEditorHeading scene={scene} />
      <SceneTextFields content={content} setContent={setContent} />
      <MentionComposer
        candidates={candidates}
        content={content}
        setContent={setContent}
      />
      {mentions.length ? (
        <MentionProperties
          content={content}
          setContent={setContent}
          candidates={candidates}
        />
      ) : null}
      <SceneVisualFields content={content} setContent={setContent} />
      <SceneSaveBar
        scene={scene}
        content={content}
        busy={busy}
        onSave={onSave}
      />
    </section>
  );
}

function SceneSaveBar({
  scene,
  content,
  busy,
  onSave,
}: {
  scene: SceneRecord;
  content: AuthoringSceneContent;
  busy: boolean;
  onSave: (content: AuthoringSceneContent) => Promise<void>;
}) {
  return (
    <div className="form-actions scene-save-bar">
      <button
        type="button"
        className="button button--primary"
        disabled={busy}
        onClick={() => void onSave(content)}
      >
        {busy ? "جارٍ حفظ النسخة…" : "حفظ نسخة المشهد"}
      </button>
      <span
        className={
          scene.version.needsAuthoring
            ? "scene-state scene-state--draft"
            : "scene-state"
        }
      >
        {scene.version.needsAuthoring ? "يحتاج استكمالًا" : "مكتمل يدويًا"}
      </span>
    </div>
  );
}

function SceneEditorHeading({ scene }: { scene: SceneRecord }) {
  return (
    <header className="authoring-section-heading">
      <div>
        <p className="eyebrow">مشهد {scene.scene.storyPageIndex}</p>
        <h3 id="scene-editor-title">نص المشهد وتوجيهه</h3>
      </div>
      <span className="plain-badge">نسخة ثابتة عند الحفظ</span>
    </header>
  );
}

function SceneTextFields({ content, setContent }: EditorProps) {
  return (
    <div className="form-grid">
      <TextAreaField
        label="هدف المشهد"
        value={content.purpose}
        onChange={(purpose) => setContent({ ...content, purpose })}
      />
      <TextAreaField
        label="وصف المشهد"
        value={content.description}
        onChange={(description) => setContent({ ...content, description })}
      />
      <label className="field field--wide">
        <span>النص المصري الظاهر في الكتاب</span>
        <textarea
          value={content.narrativeText}
          onChange={(event) =>
            setContent({ ...content, narrativeText: event.target.value })
          }
          placeholder="اكتب السرد باللهجة المصرية الطبيعية…"
        />
      </label>
    </div>
  );
}

function MentionComposer({
  candidates,
  content,
  setContent,
}: EditorProps & { candidates: MentionCandidate[] }) {
  const [query, setQuery] = useState("");
  const visibleCandidates = filterCandidates(query, candidates);
  return (
    <section className="mention-composer" aria-labelledby="mention-heading">
      <div>
        <h4 id="mention-heading">الشخصيات داخل المشهد</h4>
        <p>الأزرار تحفظ هوية الشخصية، وليس الاسم الظاهر.</p>
      </div>
      <MentionEntry
        value={query}
        candidates={candidates}
        content={content}
        setValue={setQuery}
        setContent={setContent}
      />
      <MentionPicker
        candidates={visibleCandidates}
        onSelect={(characterId) => {
          setContent(addMention(content, characterId));
          setQuery("");
        }}
      />
      <GroupActions content={content} setContent={setContent} />
      <MentionTokens
        content={content}
        candidates={candidates}
        setContent={setContent}
      />
    </section>
  );
}

function MentionEntry({
  value,
  candidates,
  content,
  setValue,
  setContent,
}: EditorProps & {
  value: string;
  candidates: MentionCandidate[];
  setValue: (value: string) => void;
}) {
  function commit() {
    if (!value.trim()) return;
    setContent(appendTypedSegment(content, value, candidates));
    setValue("");
  }
  return (
    <div className="mention-entry">
      <label className="field">
        <span>ابحث أو الصق إشارة تبدأ بـ @</span>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            commit();
          }}
          placeholder="@أحمد علي"
        />
      </label>
      <button type="button" onClick={commit}>
        إضافة النص أو الإشارة
      </button>
    </div>
  );
}

function MentionPicker({
  candidates,
  onSelect,
}: {
  candidates: MentionCandidate[];
  onSelect: (characterId: string) => void;
}) {
  return (
    <div className="mention-picker" role="group" aria-label="إضافة إشارة شخصية">
      {candidates.map((candidate) => (
        <button
          key={candidate.characterId}
          type="button"
          className="mention-option"
          onClick={() => onSelect(candidate.characterId)}
        >
          {candidate.thumbnailUrl ? (
            <img src={candidate.thumbnailUrl} alt="" />
          ) : (
            <span aria-hidden="true">@</span>
          )}
          <b>{candidate.displayName}</b>
          <small>
            {relationshipLabel(candidate.relationshipType)}،{" "}
            {candidate.narrativeRole}
          </small>
        </button>
      ))}
    </div>
  );
}

function GroupActions({ content, setContent }: EditorProps) {
  return (
    <div className="group-actions" aria-label="إشارات المجموعات">
      {(["hero", "friends", "family"] as const).map((group) => (
        <button
          key={group}
          type="button"
          onClick={() => setContent(addGroup(content, group))}
        >
          @{groupLabel(group)}
        </button>
      ))}
    </div>
  );
}

function MentionTokens({
  content,
  candidates,
  setContent,
}: EditorProps & { candidates: MentionCandidate[] }) {
  const segments = content.documentSegments;
  return (
    <ol className="mention-tokens" aria-label="الإشارات المرتبة">
      {segments.map((segment, index) => (
        <li
          key={`${segment.type}-${index}`}
          className={
            segment.type === "unresolved"
              ? "mention-token mention-token--unresolved"
              : "mention-token"
          }
        >
          <span>{segmentLabel(segment, candidates)}</span>
          <button
            type="button"
            aria-label={`حذف ${segmentLabel(segment, candidates)}`}
            onClick={() =>
              setContent({
                ...content,
                documentSegments: segments.filter(
                  (_, itemIndex) => itemIndex !== index,
                ),
              })
            }
          >
            حذف
          </button>
        </li>
      ))}
    </ol>
  );
}

function MentionProperties({
  content,
  setContent,
  candidates,
}: EditorProps & { candidates: MentionCandidate[] }) {
  const index = content.documentSegments.findIndex(
    (item) => item.type === "mention",
  );
  const segment = content.documentSegments[index];
  if (!segment || segment.type !== "mention") return null;
  const name =
    candidates.find((item) => item.characterId === segment.characterId)
      ?.displayName ?? "الشخصية";
  const update = (patch: Partial<typeof segment.props>) =>
    updateMentionProperties(content, index, segment, patch, setContent);
  return (
    <fieldset className="mention-properties">
      <legend>خصائص @{name}</legend>
      <div className="form-grid form-grid--three">
        <InputField
          label="الفعل"
          value={segment.props.action}
          onChange={(action) => update({ action })}
        />
        <InputField
          label="المشاعر"
          value={segment.props.emotion}
          onChange={(emotion) => update({ emotion })}
        />
        <InputField
          label="الموضع"
          value={segment.props.position ?? ""}
          onChange={(position) => update({ position: position || null })}
        />
        <InputField
          label="شيء يحمله"
          value={segment.props.heldObject ?? ""}
          onChange={(heldObject) => update({ heldObject: heldObject || null })}
        />
        <InputField
          label="الحوار"
          value={segment.props.dialogue ?? ""}
          onChange={(dialogue) =>
            update({ dialogue: dialogue || null, speaks: Boolean(dialogue) })
          }
        />
      </div>
    </fieldset>
  );
}

function updateMentionProperties(
  content: AuthoringSceneContent,
  index: number,
  segment: Extract<
    AuthoringSceneContent["documentSegments"][number],
    { type: "mention" }
  >,
  patch: Partial<typeof segment.props>,
  setContent: (content: AuthoringSceneContent) => void,
): void {
  const documentSegments = [...content.documentSegments];
  documentSegments[index] = {
    ...segment,
    props: { ...segment.props, ...patch },
  };
  setContent({ ...content, documentSegments });
}

function SceneVisualFields({ content, setContent }: EditorProps) {
  return (
    <fieldset className="authoring-fieldset scene-visual-fields">
      <legend>تكوين الصورة</legend>
      <div className="form-grid form-grid--three">
        <InputField
          label="المكان"
          value={content.environment}
          onChange={(environment) => setContent({ ...content, environment })}
        />
        <InputField
          label="وقت اليوم"
          value={content.timeOfDay}
          onChange={(timeOfDay) => setContent({ ...content, timeOfDay })}
        />
        <InputField
          label="التكوين"
          value={content.composition}
          onChange={(composition) => setContent({ ...content, composition })}
        />
        <InputField
          label="الكاميرا والإطار"
          value={content.cameraFraming}
          onChange={(cameraFraming) =>
            setContent({ ...content, cameraFraming })
          }
        />
        <label className="sequential-choice">
          <input
            type="checkbox"
            checked={content.twoImageMoment}
            onChange={(event) =>
              setContent({ ...content, twoImageMoment: event.target.checked })
            }
          />
          <span>
            <strong>لحظتان متتابعتان</strong>
            <small>
              فعّلها فقط إذا كان المشهد يحتاج صورتين مرتبطتين فعلًا.
            </small>
          </span>
        </label>
      </div>
    </fieldset>
  );
}

interface EditorProps {
  content: AuthoringSceneContent;
  setContent: (content: AuthoringSceneContent) => void;
}

function TextAreaField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function InputField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function addMention(
  content: AuthoringSceneContent,
  characterId: string,
): AuthoringSceneContent {
  return {
    ...content,
    documentSegments: [
      ...content.documentSegments,
      { type: "mention", characterId, props: emptyProps() },
    ],
  };
}

function addGroup(
  content: AuthoringSceneContent,
  groupKey: "hero" | "friends" | "family",
): AuthoringSceneContent {
  return {
    ...content,
    documentSegments: [
      ...content.documentSegments,
      { type: "group", groupKey },
    ],
  };
}

function appendTypedSegment(
  content: AuthoringSceneContent,
  rawValue: string,
  candidates: MentionCandidate[],
): AuthoringSceneContent {
  const value = rawValue.trim();
  const matches = exactCandidates(value, candidates);
  const segment: AuthoringSceneContent["documentSegments"][number] =
    value.startsWith("@") && matches.length === 1
      ? {
          type: "mention",
          characterId: matches[0].characterId,
          props: emptyProps(),
        }
      : value.startsWith("@")
        ? { type: "unresolved", text: value }
        : { type: "text", text: value };
  return {
    ...content,
    documentSegments: [...content.documentSegments, segment],
  };
}

function filterCandidates(
  query: string,
  candidates: MentionCandidate[],
): MentionCandidate[] {
  const normalized = normalizeMention(query);
  return candidates.filter(
    (item) =>
      !item.archived &&
      (!normalized || normalizeMention(item.displayName).includes(normalized)),
  );
}

function exactCandidates(
  query: string,
  candidates: MentionCandidate[],
): MentionCandidate[] {
  const normalized = normalizeMention(query);
  return candidates.filter(
    (item) =>
      !item.archived && normalizeMention(item.displayName) === normalized,
  );
}

function normalizeMention(value: string): string {
  return value
    .replace(/^@/u, "")
    .trim()
    .replace(/\s+/gu, " ")
    .normalize("NFC")
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu, "")
    .toLocaleLowerCase("und");
}

function emptyProps() {
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

function segmentLabel(
  segment: AuthoringSceneContent["documentSegments"][number],
  candidates: MentionCandidate[],
): string {
  if (segment.type === "mention")
    return mentionLabel(candidates, segment.characterId);
  if (segment.type === "group") return `@${groupLabel(segment.groupKey)}`;
  return segment.text;
}

function mentionLabel(candidates: MentionCandidate[], characterId: string) {
  const candidate = candidates.find((item) => item.characterId === characterId);
  if (!candidate) return "@شخصية";
  return `@${candidate.displayName}${candidate.archived ? " — مؤرشفة" : ""}`;
}

function groupLabel(group: "hero" | "friends" | "family") {
  return { hero: "البطل", friends: "الأصدقاء", family: "العيلة" }[group];
}
