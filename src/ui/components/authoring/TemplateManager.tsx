import { useState, type FormEvent } from "react";

import type {
  AuthoringTemplateContent,
  AuthoringTemplateRecord,
} from "../../types";

export function TemplateManager({
  templates,
  busy,
  canExtract,
  onCreate,
  onUpdate,
  onExtract,
}: TemplateManagerProps) {
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [selectedId, setSelectedId] = useState(templates[0]?.id ?? "");
  const source =
    templates.find(({ id }) => id === selectedId) ?? templates[0] ?? null;
  return (
    <section className="template-manager" aria-label="إدارة القوالب">
      <TemplateManagerControls
        templates={templates}
        source={source}
        mode={mode}
        setMode={setMode}
        setSelectedId={setSelectedId}
      />
      {source ? (
        <TemplateDraftForm
          key={`${mode}:${source.id}:${source.version.id}`}
          source={source}
          mode={mode}
          busy={busy}
          onCreate={onCreate}
          onUpdate={onUpdate}
        />
      ) : null}
      {canExtract ? (
        <TemplateExtraction busy={busy} onExtract={onExtract} />
      ) : null}
    </section>
  );
}

function TemplateManagerControls({
  templates,
  source,
  mode,
  setMode,
  setSelectedId,
}: {
  templates: AuthoringTemplateRecord[];
  source: AuthoringTemplateRecord | null;
  mode: "create" | "edit";
  setMode: (mode: "create" | "edit") => void;
  setSelectedId: (id: string) => void;
}) {
  return (
    <div className="template-manager-controls">
      <label className="field">
        <span>عملية القالب</span>
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as typeof mode)}
        >
          <option value="create">قالب جديد من بنية موجودة</option>
          <option value="edit">نسخة تحرير جديدة</option>
        </select>
      </label>
      <label className="field">
        <span>القالب الأساسي</span>
        <select
          value={source?.id ?? ""}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.version.content.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function TemplateDraftForm({
  source,
  mode,
  busy,
  onCreate,
  onUpdate,
}: {
  source: AuthoringTemplateRecord;
  mode: "create" | "edit";
  busy: boolean;
  onCreate: (content: AuthoringTemplateContent) => Promise<void>;
  onUpdate: (
    template: AuthoringTemplateRecord,
    content: AuthoringTemplateContent,
  ) => Promise<void>;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const content = {
      ...source.version.content,
      name: formValue(data, "templateName"),
      premise: formValue(data, "templatePremise"),
    };
    void (mode === "create" ? onCreate(content) : onUpdate(source, content));
  }
  return (
    <form className="template-draft-form" onSubmit={submit}>
      <TemplateDraftFields source={source} mode={mode} />
      <button
        className="button button--secondary"
        type="submit"
        disabled={busy}
      >
        {mode === "create" ? "إنشاء قالب مستقل" : "حفظ نسخة تحرير"}
      </button>
    </form>
  );
}

function TemplateDraftFields({
  source,
  mode,
}: {
  source: AuthoringTemplateRecord;
  mode: "create" | "edit";
}) {
  return (
    <>
      <label className="field">
        <span>اسم القالب</span>
        <input
          name="templateName"
          defaultValue={
            mode === "create"
              ? `${source.version.content.name} — قالب جديد`
              : source.version.content.name
          }
          required
        />
      </label>
      <label className="field">
        <span>فكرة القالب</span>
        <textarea
          name="templatePremise"
          defaultValue={source.version.content.premise}
          required
        />
      </label>
    </>
  );
}

function TemplateExtraction({
  busy,
  onExtract,
}: {
  busy: boolean;
  onExtract: (name: string) => Promise<void>;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onExtract(formValue(new FormData(event.currentTarget), "extractName"));
  }
  return (
    <form className="template-extraction" onSubmit={submit}>
      <label className="field">
        <span>اسم القالب المستخرج من القصة المكتملة</span>
        <input name="extractName" defaultValue="قالب رحلة تعاونية" required />
      </label>
      <button
        className="button button--secondary"
        type="submit"
        disabled={busy}
      >
        استخراج بنية آمنة فقط
      </button>
    </form>
  );
}

function formValue(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

interface TemplateManagerProps {
  templates: AuthoringTemplateRecord[];
  busy: boolean;
  canExtract: boolean;
  onCreate: (content: AuthoringTemplateContent) => Promise<void>;
  onUpdate: (
    template: AuthoringTemplateRecord,
    content: AuthoringTemplateContent,
  ) => Promise<void>;
  onExtract: (name: string) => Promise<void>;
}
