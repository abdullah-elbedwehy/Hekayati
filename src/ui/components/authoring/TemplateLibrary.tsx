import type {
  AuthoringTemplateContent,
  AuthoringTemplateRecord,
} from "../../types";
import { TemplateManager } from "./TemplateManager";

export function TemplateLibrary({
  templates,
  busy,
  canExtract,
  onStatus,
  onDuplicate,
  onCreate,
  onUpdate,
  onExtract,
}: {
  templates: AuthoringTemplateRecord[];
  busy: boolean;
  canExtract: boolean;
  onStatus: (
    template: AuthoringTemplateRecord,
    status: AuthoringTemplateRecord["status"],
  ) => Promise<void>;
  onDuplicate: (template: AuthoringTemplateRecord) => Promise<void>;
  onCreate: (content: AuthoringTemplateContent) => Promise<void>;
  onUpdate: (
    template: AuthoringTemplateRecord,
    content: AuthoringTemplateContent,
  ) => Promise<void>;
  onExtract: (name: string) => Promise<void>;
}) {
  return (
    <section
      className="template-library"
      aria-labelledby="template-library-title"
    >
      <TemplateLibraryHeading />
      <TemplateManager
        templates={templates}
        busy={busy}
        canExtract={canExtract}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onExtract={onExtract}
      />
      <TemplateTable
        templates={templates}
        busy={busy}
        onStatus={onStatus}
        onDuplicate={onDuplicate}
      />
    </section>
  );
}

function TemplateLibraryHeading() {
  return (
    <header className="authoring-section-heading">
      <div>
        <p className="eyebrow">7 بدايات قابلة للإدارة</p>
        <h3 id="template-library-title">مكتبة القوالب</h3>
      </div>
      <span className="plain-badge">لا تُستبدل التعديلات عند التشغيل</span>
    </header>
  );
}

function TemplateTable({
  templates,
  busy,
  onStatus,
  onDuplicate,
}: {
  templates: AuthoringTemplateRecord[];
  busy: boolean;
  onStatus: (
    template: AuthoringTemplateRecord,
    status: AuthoringTemplateRecord["status"],
  ) => Promise<void>;
  onDuplicate: (template: AuthoringTemplateRecord) => Promise<void>;
}) {
  return (
    <div className="template-table" role="list">
      {templates.map((template) => (
        <article key={template.id} role="listitem" className="template-row">
          <div>
            <h4>{template.version.content.name}</h4>
            <p>{template.version.content.premise}</p>
          </div>
          <span
            className={`template-status template-status--${template.status}`}
          >
            {statusLabel(template.status)}
          </span>
          <TemplateActions
            template={template}
            busy={busy}
            onStatus={onStatus}
            onDuplicate={onDuplicate}
          />
        </article>
      ))}
    </div>
  );
}

function TemplateActions({
  template,
  busy,
  onStatus,
  onDuplicate,
}: {
  template: AuthoringTemplateRecord;
  busy: boolean;
  onStatus: (
    template: AuthoringTemplateRecord,
    status: AuthoringTemplateRecord["status"],
  ) => Promise<void>;
  onDuplicate: (template: AuthoringTemplateRecord) => Promise<void>;
}) {
  return (
    <div className="template-actions">
      <button
        type="button"
        disabled={busy}
        onClick={() => void onDuplicate(template)}
      >
        إنشاء نسخة
      </button>
      <TemplateLifecycleActions
        template={template}
        busy={busy}
        onStatus={onStatus}
      />
    </div>
  );
}

function TemplateLifecycleActions({
  template,
  busy,
  onStatus,
}: {
  template: AuthoringTemplateRecord;
  busy: boolean;
  onStatus: (
    template: AuthoringTemplateRecord,
    status: AuthoringTemplateRecord["status"],
  ) => Promise<void>;
}) {
  if (template.status !== "active")
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => void onStatus(template, "active")}
      >
        استعادة للاختيار
      </button>
    );
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => void onStatus(template, "disabled")}
      >
        تعطيل للاختيار
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void onStatus(template, "archived")}
      >
        أرشفة
      </button>
    </>
  );
}

function statusLabel(status: AuthoringTemplateRecord["status"]) {
  return { active: "● متاح", disabled: "◼ معطّل", archived: "○ مؤرشف" }[status];
}
