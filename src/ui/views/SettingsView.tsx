import {
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";

import { StatusLine } from "../components/StatusLine";
import type { Settings } from "../types";

interface SettingsViewProps {
  settings: Settings;
  onSave: (settings: Settings) => Promise<void>;
}

type DraftSetter = Dispatch<SetStateAction<Settings>>;
type SaveState = "idle" | "saving" | "saved" | "error";

const modelFields: Array<{ key: keyof Settings["models"]; label: string }> = [
  { key: "codexText", label: "نموذج نص Codex" },
  { key: "geminiText", label: "نموذج نص Gemini" },
  { key: "geminiImage", label: "نموذج صور Gemini" },
  { key: "geminiImageEconomy", label: "نموذج الصور الاقتصادي" },
];

export function SettingsView({ settings, onSave }: SettingsViewProps) {
  const [draft, setDraft] = useState(settings);
  const [state, setState] = useState<SaveState>("idle");
  const acknowledged = settings.firstRunAcknowledged;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("saving");
    try {
      await onSave({ ...draft, firstRunAcknowledged: acknowledged });
      setState("saved");
    } catch {
      setState("error");
    }
  }
  return (
    <main className="view" id="main-content">
      <header className="view-header">
        <p className="eyebrow">إعدادات الأساس</p>
        <h1>اختيارات واضحة، بلا أسرار مخزّنة</h1>
        <p>
          معرّفات النماذج إعدادات قابلة للتغيير. مفاتيح Gemini لا تُحفظ هنا.
        </p>
      </header>
      <form className="settings-form" onSubmit={(event) => void submit(event)}>
        <ProviderSection draft={draft} setDraft={setDraft} />
        <FoundationSection draft={draft} setDraft={setDraft} />
        <StorageSection settings={draft} />
        <FormActions state={state} />
      </form>
    </main>
  );
}

function ProviderSection({ draft, setDraft }: DraftProps) {
  return (
    <section className="section" aria-labelledby="provider-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">الاختيار المستقبلي</p>
          <h2 id="provider-heading">المزوّدون والنماذج</h2>
        </div>
        <span className="status-chip status-chip--pending">غير مُعَدّ</span>
      </div>
      <DeferredSettingsStatus settings={draft} />
      <div className="form-grid">
        <ProviderSelectors draft={draft} setDraft={setDraft} />
        <ModelFields draft={draft} setDraft={setDraft} />
      </div>
    </section>
  );
}

function DeferredSettingsStatus({ settings }: { settings: Settings }) {
  return (
    <div className="status-list deferred-settings">
      <StatusLine
        label="دورة اتصال المزوّدين"
        status={deferredLabel(settings.deferredStatus.providerLifecycle)}
        tone="pending"
      />
      <StatusLine
        label="ملفات الطباعة"
        status={deferredLabel(settings.deferredStatus.printerProfiles)}
        tone="pending"
      />
    </div>
  );
}

function ProviderSelectors({ draft, setDraft }: DraftProps) {
  return (
    <>
      <label className="field">
        <span>مزوّد النص</span>
        <select
          value={draft.textProvider}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              textProvider: provider(event.target.value),
            }))
          }
        >
          <option value="mock">المزوّد التجريبي</option>
          <option value="codex">Codex</option>
          <option value="gemini">Gemini</option>
        </select>
      </label>
      <label className="field">
        <span>مزوّد الصور</span>
        <select
          value={draft.imageProvider}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              imageProvider: provider(event.target.value),
            }))
          }
        >
          <option value="mock">المزوّد التجريبي</option>
          <option value="gemini">Gemini</option>
          <option value="codex">Codex، غير متاح حاليًا للصور</option>
        </select>
      </label>
    </>
  );
}

function ModelFields({ draft, setDraft }: DraftProps) {
  return (
    <>
      {modelFields.map((field) => (
        <ModelField
          key={field.key}
          label={field.label}
          value={draft.models[field.key]}
          onChange={(value) =>
            setDraft((current) => ({
              ...current,
              models: { ...current.models, [field.key]: value },
            }))
          }
        />
      ))}
    </>
  );
}

function FoundationSection(props: DraftProps) {
  return (
    <section className="section" aria-labelledby="foundation-settings-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">قيم محلية</p>
          <h2 id="foundation-settings-heading">التشغيل والقراءة</h2>
        </div>
      </div>
      <div className="form-grid form-grid--three">
        <RuntimeFields {...props} />
        <TypographyFields {...props} />
      </div>
    </section>
  );
}

function RuntimeFields({ draft, setDraft }: DraftProps) {
  return (
    <>
      <NumberField
        label="المهام المتزامنة لكل مزوّد"
        value={draft.concurrencyPerProvider}
        min={1}
        max={4}
        onChange={(value) =>
          setDraft((current) => ({ ...current, concurrencyPerProvider: value }))
        }
      />
      <NumberField
        label="تحذير المساحة الحرة، جيجابايت"
        value={draft.diskWarnGb}
        min={1}
        max={1000}
        onChange={(value) =>
          setDraft((current) => ({ ...current, diskWarnGb: value }))
        }
      />
      <label className="field">
        <span>نص العلامة المائية</span>
        <input
          value={draft.watermarkText}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              watermarkText: event.target.value,
            }))
          }
        />
      </label>
    </>
  );
}

function TypographyFields({ draft, setDraft }: DraftProps) {
  return (
    <>
      <NumberField
        label="أقل حجم نص لعمر 3 إلى 5"
        value={draft.typography.minimumAge3To5Pt}
        min={14}
        max={36}
        onChange={(value) =>
          updateTypography(setDraft, "minimumAge3To5Pt", value)
        }
      />
      <NumberField
        label="أقل حجم نص لعمر 6 فأكثر"
        value={draft.typography.minimumAge6PlusPt}
        min={12}
        max={36}
        onChange={(value) =>
          updateTypography(setDraft, "minimumAge6PlusPt", value)
        }
      />
    </>
  );
}

function StorageSection({ settings }: { settings: Settings }) {
  return (
    <section className="section" aria-labelledby="storage-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">للقراءة فقط</p>
          <h2 id="storage-heading">مسارات التخزين</h2>
        </div>
      </div>
      <dl className="path-list">
        <div>
          <dt>البيانات</dt>
          <dd>
            <bdi>{settings.storagePathsReadonly.data}</bdi>
          </dd>
        </div>
        <div>
          <dt>الملفات</dt>
          <dd>
            <bdi>{settings.storagePathsReadonly.assets}</bdi>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function FormActions({ state }: { state: SaveState }) {
  return (
    <div className="form-actions">
      <button
        className="button button--primary"
        type="submit"
        disabled={state === "saving"}
      >
        {state === "saving" ? "جارٍ الحفظ…" : "حفظ الإعدادات"}
      </button>
      <output className={`save-state save-state--${state}`} aria-live="polite">
        {saveMessage(state)}
      </output>
    </div>
  );
}

interface DraftProps {
  draft: Settings;
  setDraft: DraftSetter;
}

function ModelField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        dir="ltr"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

function updateTypography(
  setDraft: DraftSetter,
  key: keyof Settings["typography"],
  value: number,
) {
  setDraft((current) => ({
    ...current,
    typography: { ...current.typography, [key]: value },
  }));
}

function provider(value: string): Settings["textProvider"] {
  return value === "codex" || value === "gemini" ? value : "mock";
}

function deferredLabel(status: "not_configured"): string {
  return status === "not_configured" ? "غير مُعَدّ" : "غير متاح";
}

function saveMessage(state: SaveState): string {
  if (state === "saved") return "حُفظت الإعدادات على هذا الجهاز.";
  if (state === "error") return "تعذّر الحفظ. راجع حالة النظام وحاول مرة أخرى.";
  return "";
}
