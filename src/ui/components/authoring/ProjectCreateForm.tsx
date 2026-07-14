import { useState, type FormEvent } from "react";

import { relationshipLabel } from "../library/library-utils";
import type {
  AuthoringProjectInput,
  AuthoringTemplateRecord,
  LibraryCharacter,
  LibraryLook,
} from "../../types";

export function ProjectCreateForm({
  characters,
  looks,
  templates,
  busy,
  onCreate,
  onCancel,
}: {
  characters: LibraryCharacter[];
  looks: LibraryLook[];
  templates: AuthoringTemplateRecord[];
  busy: boolean;
  onCreate: (input: AuthoringProjectInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const state = useProjectCreateState(characters, onCreate);
  return (
    <form
      className="authoring-create"
      onSubmit={(event) => void state.submit(event)}
    >
      <CreateHeading onCancel={onCancel} />
      <StoryBasics templates={templates} />
      <CharacterSelection
        characters={characters}
        selected={state.selected}
        mainChildId={state.mainChildId}
        onMainChild={state.chooseMain}
        onToggle={state.setSelected}
      />
      <ParticipantConfiguration
        characters={characters}
        looks={looks}
        selected={state.selected}
        mainChildId={state.mainChildId}
      />
      <StoryDirection />
      <CustomStoryFields />
      <EndingFields />
      <CreateActions busy={busy} enabled={Boolean(state.mainChildId)} />
    </form>
  );
}

function CreateActions({ busy, enabled }: { busy: boolean; enabled: boolean }) {
  return (
    <div className="form-actions authoring-create-actions">
      <button className="button button--primary" disabled={busy || !enabled}>
        {busy ? "جارٍ إنشاء المشروع…" : "إنشاء المشروع ومشاهد القصة"}
      </button>
      <span className="quiet-note">لا يجري أي اتصال بمزوّد ذكاء اصطناعي.</span>
    </div>
  );
}

function useProjectCreateState(
  characters: LibraryCharacter[],
  onCreate: (input: AuthoringProjectInput) => Promise<void>,
) {
  const eligible = eligibleCharacters(characters);
  const initial =
    eligible.find(
      (item) => item.currentVersion.profile.relationship.type === "main_child",
    )?.id ??
    eligible[0]?.id ??
    "";
  const [mainChildId, setMainChildId] = useState(initial);
  const [selected, setSelected] = useState<string[]>(initial ? [initial] : []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onCreate(
      projectInput(
        new FormData(event.currentTarget),
        mainChildId,
        selected,
        characters,
      ),
    );
  }
  function chooseMain(id: string) {
    setMainChildId(id);
    setSelected((current) => [...new Set([...current, id])]);
  }
  return { mainChildId, selected, setSelected, submit, chooseMain };
}

function CreateHeading({ onCancel }: { onCancel?: () => void }) {
  return (
    <header className="authoring-section-heading">
      <div>
        <p className="eyebrow">إعداد يدوي بالكامل</p>
        <h2>مشروع كتاب جديد</h2>
        <p>اختر العائلة والقالب والشخصيات، ثم ابدأ تأليف الصفحات.</p>
      </div>
      {onCancel ? (
        <button
          className="button button--secondary"
          type="button"
          onClick={onCancel}
        >
          إلغاء
        </button>
      ) : null}
    </header>
  );
}

function StoryBasics({ templates }: { templates: AuthoringTemplateRecord[] }) {
  return (
    <fieldset className="authoring-fieldset">
      <legend>أساس الحكاية</legend>
      <div className="form-grid form-grid--three">
        <label className="field">
          <span>عنوان المشروع</span>
          <input name="title" defaultValue="مغامرة الفضاء" required />
        </label>
        <StoryTypeField />
        <label className="field">
          <span>القالب</span>
          <select name="templateSeedKey" defaultValue="space_adventure">
            {templates.map(({ template, version }) => (
              <option key={template.id} value={template.seedKey ?? template.id}>
                {version.content.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>عدد الصفحات الداخلية</span>
          <select name="pageCount" defaultValue="16">
            <option value="16">16 صفحة، 12 مشهدًا</option>
            <option value="24">24 صفحة، 20 مشهدًا</option>
          </select>
        </label>
        <label className="field">
          <span>المناسبة</span>
          <input name="occasion" defaultValue="هدية خاصة" />
        </label>
        <label className="field field--wide">
          <span>الإهداء</span>
          <textarea
            name="dedicationText"
            defaultValue="إلى بطل الحكاية، بمحبة."
          />
        </label>
      </div>
    </fieldset>
  );
}

function StoryTypeField() {
  return (
    <SelectField
      name="storyType"
      label="نوع الحكاية"
      defaultValue="saved_template"
      options={[
        ["connected_adventure", "مغامرة مترابطة"],
        ["related_situations", "مواقف مرتبطة"],
        ["saved_template", "قالب محفوظ"],
        ["fully_custom", "قصة مخصصة بالكامل"],
      ]}
    />
  );
}

function CharacterSelection({
  characters,
  selected,
  mainChildId,
  onMainChild,
  onToggle,
}: {
  characters: LibraryCharacter[];
  selected: string[];
  mainChildId: string;
  onMainChild: (id: string) => void;
  onToggle: (ids: string[]) => void;
}) {
  const eligible = eligibleCharacters(characters);
  return (
    <fieldset className="authoring-fieldset">
      <legend>أبطال المشروع</legend>
      <label className="field authoring-anchor-select">
        <span>الطفل بطل الكتاب</span>
        <select
          value={mainChildId}
          onChange={(event) => onMainChild(event.target.value)}
        >
          {eligible.map((character) => (
            <option key={character.id} value={character.id}>
              {character.currentVersion.profile.name}
            </option>
          ))}
        </select>
      </label>
      <div className="participant-grid">
        {eligible.map((character) => (
          <ParticipantChoice
            key={character.id}
            character={character}
            checked={selected.includes(character.id)}
            locked={character.id === mainChildId}
            onChange={(checked) =>
              onToggle(toggleParticipant(selected, character.id, checked))
            }
          />
        ))}
      </div>
    </fieldset>
  );
}

function ParticipantChoice({
  character,
  checked,
  locked,
  onChange,
}: {
  character: LibraryCharacter;
  checked: boolean;
  locked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const profile = character.currentVersion.profile;
  return (
    <label
      className={
        checked
          ? "participant-choice participant-choice--selected"
          : "participant-choice"
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={locked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <strong>{profile.name}</strong>
        <small>{relationshipLabel(profile.relationship)}</small>
      </span>
      {locked ? <em>البطل</em> : null}
    </label>
  );
}

function ParticipantConfiguration({
  characters,
  looks,
  selected,
  mainChildId,
}: {
  characters: LibraryCharacter[];
  looks: LibraryLook[];
  selected: string[];
  mainChildId: string;
}) {
  return (
    <fieldset className="authoring-fieldset participant-settings">
      <legend>الدور والمظهر داخل المشروع</legend>
      <div className="participant-settings-grid">
        {selected.map((characterId) => (
          <ParticipantSetting
            key={characterId}
            character={characters.find((item) => item.id === characterId)!}
            characters={characters}
            looks={looks.filter((look) => look.characterId === characterId)}
            mainChild={characterId === mainChildId}
          />
        ))}
      </div>
    </fieldset>
  );
}

function ParticipantSetting({
  character,
  characters,
  looks,
  mainChild,
}: {
  character: LibraryCharacter;
  characters: LibraryCharacter[];
  looks: LibraryLook[];
  mainChild: boolean;
}) {
  const name = character.currentVersion.profile.name;
  return (
    <div className="participant-setting">
      <strong>{name}</strong>
      <label className="field">
        <span>الدور السردي لـ {name}</span>
        <input
          name={`role:${character.id}`}
          defaultValue={mainChild ? "البطل" : roleFor(characters, character.id)}
        />
      </label>
      <label className="field">
        <span>مظهر {name}</span>
        <select name={`appearance:${character.id}`} defaultValue="base">
          <option value="base">المظهر الأساسي</option>
          {looks
            .filter((look) => look.status === "active")
            .map((look) => (
              <option key={look.id} value={`look:${look.id}`}>
                {look.currentVersion.name}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}

function StoryDirection() {
  return (
    <fieldset className="authoring-fieldset">
      <legend>اتجاه النص والصورة</legend>
      <div className="form-grid form-grid--three">
        {directionFields.map((props) => (
          <SelectField key={props.name} {...props} />
        ))}
        <DirectionNotes />
      </div>
    </fieldset>
  );
}

function DirectionNotes() {
  return (
    <>
      <label className="field field--wide">
        <span>ملاحظات الملابس</span>
        <textarea
          name="clothingNotes"
          defaultValue="ملابس مريحة وثابتة بين المشاهد."
        />
      </label>
      <label className="field field--wide">
        <span>حدود وملاحظات القصة</span>
        <textarea
          name="customNotes"
          defaultValue="قصة مطمئنة، بلا وعظ أو تخويف."
        />
      </label>
      <label className="field">
        <span>وصف النبرة المخصصة</span>
        <input name="customTone" defaultValue="هادئة وحماسية" />
      </label>
      <label className="field">
        <span>وصف الهدف المخصص</span>
        <input name="customGoal" />
      </label>
      <label className="field">
        <span>طريقة ظهور الهدف</span>
        <select name="goalPresentation" defaultValue="indirect">
          <option value="indirect">غير مباشر بالكامل</option>
          <option value="acknowledged_ending">إشارة لطيفة في النهاية</option>
        </select>
      </label>
      <label className="field">
        <span>نسبة السرد المختارة، اختيارية</span>
        <input
          name="selectedNarrationPercent"
          type="number"
          min="0"
          max="100"
          placeholder="اتركها للاقتراح التلقائي"
        />
      </label>
    </>
  );
}

function CustomStoryFields() {
  return (
    <fieldset className="authoring-fieldset custom-story-fields">
      <legend>تفاصيل القصة المخصصة</legend>
      <p className="quiet-note">
        تُستخدم عند اختيار «قصة مخصصة بالكامل»، ويمكن حفظها ناقصة كمسودة.
      </p>
      <div className="form-grid form-grid--three">
        <TextAreaInput name="customPremise" label="فكرة القصة" />
        <TextAreaInput name="beginningBeat" label="لحظة البداية" />
        <TextAreaInput name="middleBeat" label="لحظة الوسط" />
        <TextAreaInput name="endingBeat" label="لحظة النهاية" />
        <TextAreaInput
          name="contentBoundaries"
          label="حدود المحتوى، سطر لكل حد"
        />
      </div>
    </fieldset>
  );
}

function TextAreaInput({ name, label }: { name: string; label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea name={name} />
    </label>
  );
}

function SelectField({
  name,
  label,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: string[][];
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={defaultValue}>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function EndingFields() {
  return (
    <fieldset className="authoring-fieldset">
      <legend>صفحتا الختام</legend>
      <div className="form-grid">
        <label className="field">
          <span>لحظة الوداع</span>
          <textarea
            name="farewellText"
            defaultValue="عاد البطل سعيدًا بما تعلّمه."
          />
        </label>
        <label className="field">
          <span>سطر العلامة</span>
          <textarea name="brandLine" defaultValue="صُنع خصيصًا لبطل الحكاية" />
        </label>
      </div>
    </fieldset>
  );
}

function projectInput(
  data: FormData,
  mainChildId: string,
  selected: string[],
  characters: LibraryCharacter[],
): AuthoringProjectInput {
  const storyType = field(
    data,
    "storyType",
    "saved_template",
  ) as AuthoringProjectInput["storyType"];
  const templateSeedKey = field(data, "templateSeedKey", "space_adventure");
  return {
    title: field(data, "title"),
    mainChildId,
    participants: projectParticipants(data, selected, mainChildId, characters),
    occasion: field(data, "occasion"),
    dedicationText: field(data, "dedicationText"),
    storyType,
    templateSeedKey: storyType === "saved_template" ? templateSeedKey : null,
    pageCount: Number(field(data, "pageCount")) as 16 | 24,
    ...directionInput(data),
    selectedNarrationPercent: optionalPercent(data, "selectedNarrationPercent"),
    customStory: customStoryInput(data, storyType),
    endingPages: {
      farewellText: field(data, "farewellText"),
      brandLine: field(data, "brandLine"),
    },
  };
}

function projectParticipants(
  data: FormData,
  selected: string[],
  mainChildId: string,
  characters: LibraryCharacter[],
): AuthoringProjectInput["participants"] {
  return selected.map((characterId) => ({
    characterId,
    narrativeRole: field(
      data,
      `role:${characterId}`,
      characterId === mainChildId ? "البطل" : roleFor(characters, characterId),
    ),
    appearance: appearanceInput(
      field(data, `appearance:${characterId}`, "base"),
    ),
  }));
}

function appearanceInput(
  value: string,
): AuthoringProjectInput["participants"][number]["appearance"] {
  return value.startsWith("look:")
    ? { type: "shared_look", lookId: value.slice("look:".length) }
    : { type: "base" };
}

function directionInput(data: FormData) {
  const tone = field(data, "tone") as AuthoringProjectInput["tone"];
  return {
    tone,
    customTone: tone === "custom" ? field(data, "customTone") : null,
    illustrationStyleId: field(
      data,
      "illustrationStyleId",
    ) as AuthoringProjectInput["illustrationStyleId"],
    hiddenGoal: hiddenGoalInput(data),
    clothingNotes: field(data, "clothingNotes"),
    customNotes: field(data, "customNotes"),
    audienceAgeBand: field(
      data,
      "audienceAgeBand",
    ) as AuthoringProjectInput["audienceAgeBand"],
    readingLevel: field(
      data,
      "readingLevel",
    ) as AuthoringProjectInput["readingLevel"],
    sceneComplexity: field(
      data,
      "sceneComplexity",
    ) as AuthoringProjectInput["sceneComplexity"],
  };
}

function hiddenGoalInput(data: FormData): AuthoringProjectInput["hiddenGoal"] {
  const goal = field(data, "hiddenGoal", "none");
  if (goal === "none") return null;
  return {
    goal: goal as NonNullable<AuthoringProjectInput["hiddenGoal"]>["goal"],
    customGoal: goal === "custom" ? field(data, "customGoal") : null,
    presentation: field(data, "goalPresentation", "indirect") as NonNullable<
      AuthoringProjectInput["hiddenGoal"]
    >["presentation"],
  };
}

function customStoryInput(
  data: FormData,
  storyType: AuthoringProjectInput["storyType"],
): AuthoringProjectInput["customStory"] {
  if (storyType !== "fully_custom") return null;
  return {
    premise: field(data, "customPremise"),
    beginningBeat: field(data, "beginningBeat"),
    middleBeat: field(data, "middleBeat"),
    endingBeat: field(data, "endingBeat"),
    contentBoundaries: field(data, "contentBoundaries")
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

function optionalPercent(data: FormData, name: string): number | null {
  const value = field(data, name).trim();
  return value ? Number(value) : null;
}

function eligibleCharacters(characters: LibraryCharacter[]) {
  return characters.filter(
    (item) =>
      item.status === "active" &&
      item.currentVersion.profile.relationship.type !== "pet",
  );
}

function toggleParticipant(
  selected: string[],
  characterId: string,
  checked: boolean,
): string[] {
  return checked
    ? [...new Set([...selected, characterId])]
    : selected.filter((id) => id !== characterId);
}

const directionFields: Array<{
  name: string;
  label: string;
  defaultValue: string;
  options: string[][];
}> = [
  {
    name: "tone",
    label: "النبرة",
    defaultValue: "adventurous",
    options: [
      ["adventurous", "مغامرة"],
      ["light_funny", "خفيفة ومرحة"],
      ["warm_family", "عائلية دافئة"],
      ["magical", "سحرية"],
      ["educational_non_preachy", "تعليمية بلا وعظ"],
      ["custom", "نبرة مخصصة"],
    ],
  },
  {
    name: "illustrationStyleId",
    label: "أسلوب الرسم",
    defaultValue: "modern_cartoon",
    options: [
      ["modern_cartoon", "كرتوني حديث"],
      ["colorful_2d", "ثنائي الأبعاد ملوّن"],
      ["soft_watercolor", "ألوان مائية هادئة"],
    ],
  },
  {
    name: "audienceAgeBand",
    label: "الفئة العمرية",
    defaultValue: "age_6_8",
    options: [
      ["age_3_5", "3–5 سنوات"],
      ["age_6_8", "6–8 سنوات"],
      ["age_9_12", "9–12 سنة"],
    ],
  },
  {
    name: "readingLevel",
    label: "مستوى القراءة",
    defaultValue: "developing",
    options: [
      ["early", "مبتدئ"],
      ["developing", "نامٍ"],
      ["independent", "مستقل"],
    ],
  },
  {
    name: "sceneComplexity",
    label: "تعقيد المشهد",
    defaultValue: "medium",
    options: [
      ["low", "بسيط"],
      ["medium", "متوسط"],
      ["high", "غني"],
    ],
  },
  {
    name: "hiddenGoal",
    label: "الهدف الخفي",
    defaultValue: "confidence",
    options: [
      ["none", "بلا هدف خفي"],
      ["confidence", "الثقة"],
      ["enjoying_school", "الاستمتاع بالمدرسة"],
      ["reducing_phone_use", "تقليل استخدام الهاتف"],
      ["courage", "الشجاعة"],
      ["cooperation", "التعاون"],
      ["sharing", "المشاركة"],
      ["welcoming_sibling", "الترحيب بمولود جديد"],
      ["responsibility", "المسؤولية"],
      ["custom", "هدف مخصص"],
    ],
  },
];

function field(data: FormData, name: string, fallback = ""): string {
  const value = data.get(name);
  return typeof value === "string" ? value : fallback;
}

function roleFor(characters: LibraryCharacter[], id: string): string {
  const profile = characters.find((item) => item.id === id)?.currentVersion
    .profile;
  return profile ? relationshipLabel(profile.relationship) : "مشارك";
}
