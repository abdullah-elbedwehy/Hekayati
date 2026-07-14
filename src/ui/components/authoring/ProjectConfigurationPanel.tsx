import type { FormEvent } from "react";

import type {
  AuthoringParticipantInput,
  AuthoringProjectInput,
  AuthoringProjectWorkspace,
} from "../../types";

export function ProjectConfigurationPanel({
  workspace,
  busy,
  onSave,
}: {
  workspace: AuthoringProjectWorkspace;
  busy: boolean;
  onSave: (input: AuthoringProjectInput) => Promise<void>;
}) {
  const config = workspace.version.storyConfig;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSave(
      configurationInput(workspace, new FormData(event.currentTarget)),
    );
  }
  return (
    <form
      className="project-configuration"
      aria-labelledby="configuration-title"
      onSubmit={submit}
    >
      <ConfigurationHeading />
      <BookTextFields config={config} />
      <EndingConfiguration config={config} />
      <button className="button button--secondary" disabled={busy}>
        {busy ? "جارٍ حفظ النسخة…" : "حفظ نسخة إعداد جديدة"}
      </button>
    </form>
  );
}

function ConfigurationHeading() {
  return (
    <header className="authoring-section-heading">
      <div>
        <p className="eyebrow">تعديل متوقع الرأس</p>
        <h3 id="configuration-title">نصوص الكتاب والإعداد</h3>
      </div>
      <span className="plain-badge">النسخة السابقة تبقى قابلة للقراءة</span>
    </header>
  );
}

type StoryConfig = AuthoringProjectWorkspace["version"]["storyConfig"];

function BookTextFields({ config }: { config: StoryConfig }) {
  return (
    <div className="form-grid form-grid--three">
      <ConfigInput name="title" label="عنوان المشروع" value={config.title} />
      <ConfigInput name="occasion" label="المناسبة" value={config.occasion} />
      <ConfigInput
        name="selectedNarrationPercent"
        label="نسبة السرد المختارة"
        value={
          config.narrationDialogueBalance.operatorEdited
            ? String(config.narrationDialogueBalance.selectedNarrationPercent)
            : ""
        }
        type="number"
      />
      <ConfigArea
        name="dedicationText"
        label="الإهداء"
        value={config.dedicationText}
      />
      <ConfigArea
        name="clothingNotes"
        label="ملاحظات الملابس"
        value={config.clothingNotes}
      />
      <ConfigArea
        name="customNotes"
        label="ملاحظات القصة"
        value={config.customNotes}
      />
    </div>
  );
}

function EndingConfiguration({ config }: { config: StoryConfig }) {
  return (
    <div className="form-grid">
      <ConfigArea
        name="farewellText"
        label="نص الوداع"
        value={config.endingPages.farewellText}
      />
      <ConfigArea
        name="brandLine"
        label="سطر العلامة"
        value={config.endingPages.brandLine}
      />
    </div>
  );
}

function configurationInput(
  workspace: AuthoringProjectWorkspace,
  data: FormData,
): AuthoringProjectInput {
  const config = workspace.version.storyConfig;
  const selected = formValue(data, "selectedNarrationPercent").trim();
  return {
    title: formValue(data, "title"),
    mainChildId: config.mainChildId,
    participants: config.participants.map(participantInput),
    occasion: formValue(data, "occasion"),
    dedicationText: formValue(data, "dedicationText"),
    storyType: config.storyType,
    templateId: config.templateId,
    templateSeedKey: null,
    pageCount: config.pageCount,
    tone: config.tone,
    customTone: config.customTone,
    illustrationStyleId: config.illustrationStyleId,
    hiddenGoal: config.hiddenGoal,
    clothingNotes: formValue(data, "clothingNotes"),
    customNotes: formValue(data, "customNotes"),
    audienceAgeBand: config.audienceAgeBand,
    readingLevel: config.readingLevel,
    sceneComplexity: config.sceneComplexity,
    selectedNarrationPercent: selected ? Number(selected) : null,
    customStory: config.customStory,
    endingPages: {
      farewellText: formValue(data, "farewellText"),
      brandLine: formValue(data, "brandLine"),
    },
  };
}

function participantInput(
  participant: StoryConfig["participants"][number],
): AuthoringParticipantInput {
  const appearance = participant.appearance;
  return {
    characterId: participant.characterId,
    narrativeRole: participant.narrativeRole,
    appearance:
      appearance.type === "shared_look"
        ? { type: "shared_look", lookId: appearance.lookId }
        : appearance.type === "base"
          ? { type: "base" }
          : undefined,
  };
}

function ConfigInput({
  name,
  label,
  value,
  type = "text",
}: {
  name: string;
  label: string;
  value: string;
  type?: "text" | "number";
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        min={type === "number" ? 0 : undefined}
        max={type === "number" ? 100 : undefined}
        defaultValue={value}
        required={name === "title"}
      />
    </label>
  );
}

function ConfigArea({
  name,
  label,
  value,
}: {
  name: string;
  label: string;
  value: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea name={name} defaultValue={value} />
    </label>
  );
}

function formValue(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}
