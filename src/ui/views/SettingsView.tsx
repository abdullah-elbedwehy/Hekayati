import {
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";

import { ApiError, toSettingsUpdate, type ApiClient } from "../api";
import { ProviderSettingsPanel } from "../components/providers/ProviderSettingsPanel";
import {
  formatQueueNumber,
  operationLabel,
  providerLabel,
} from "../components/jobs/format";
import type {
  Settings,
  SettingsTargetChangePreview,
  SettingsUpdate,
} from "../types";

interface SettingsViewProps {
  client: ApiClient;
  settings: Settings;
  onSave: (settings: Settings) => Promise<void>;
  onCommitted: (settings: Settings) => void;
  onStaleSession: () => void;
}

type DraftSetter = Dispatch<SetStateAction<Settings>>;
type SaveState = "idle" | "saving" | "saved" | "error";

export function SettingsView(props: SettingsViewProps) {
  const form = useSettingsForm(props);
  return (
    <main className="view" id="main-content">
      <header className="view-header">
        <p className="eyebrow">إعدادات الأساس</p>
        <h1>اختيارات واضحة، بلا أسرار مخزّنة</h1>
        <p>
          معرّفات النماذج إعدادات قابلة للتغيير. مفاتيح Gemini لا تُحفظ هنا.
        </p>
      </header>
      <form
        className="settings-form"
        onSubmit={(event) => void form.submit(event)}
      >
        <fieldset className="settings-fields" disabled={form.pending !== null}>
          <ProviderSettingsPanel
            client={props.client}
            draft={form.draft}
            setDraft={form.setDraft}
          />
          <FoundationSection draft={form.draft} setDraft={form.setDraft} />
          <StorageSection settings={form.draft} />
        </fieldset>
        {form.pending ? (
          <TargetChangeConfirmation
            pending={form.pending}
            state={form.state}
            confirm={form.confirm}
            cancel={form.cancel}
          />
        ) : (
          <FormActions state={form.state} />
        )}
      </form>
    </main>
  );
}

interface PendingTargetChange {
  preview: SettingsTargetChangePreview;
  update: SettingsUpdate;
}

function useSettingsForm({
  client,
  settings,
  onSave,
  onCommitted,
  onStaleSession,
}: SettingsViewProps) {
  const [draft, setDraft] = useState(settings);
  const [state, setState] = useState<SaveState>("idle");
  const [pending, setPending] = useState<PendingTargetChange | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    return prepareSettingsSave({
      client,
      settings,
      draft,
      onSave,
      onStaleSession,
      setState,
      setPending,
    });
  };
  const confirm = () => {
    if (!pending) return;
    void confirmTargetChange({
      client,
      pending,
      onCommitted,
      onStaleSession,
      setDraft,
      setPending,
      setState,
    });
  };
  return {
    draft,
    setDraft,
    state,
    pending,
    submit,
    confirm,
    cancel: () => setPending(null),
  };
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;

async function prepareSettingsSave(input: {
  client: ApiClient;
  settings: Settings;
  draft: Settings;
  onSave: SettingsViewProps["onSave"];
  onStaleSession: SettingsViewProps["onStaleSession"];
  setState: StateSetter<SaveState>;
  setPending: StateSetter<PendingTargetChange | null>;
}): Promise<void> {
  input.setState("saving");
  const next = {
    ...input.draft,
    firstRunAcknowledged: input.settings.firstRunAcknowledged,
  };
  const update = toSettingsUpdate(next);
  try {
    const preview = await input.client.previewSettingsTargetChange(update);
    if (preview.requiresConfirmation) {
      input.setPending({ preview, update });
      input.setState("idle");
    } else {
      await input.onSave(next);
      input.setState("saved");
    }
  } catch (reason) {
    reportStaleSession(reason, input.onStaleSession);
    input.setState("error");
  }
}

async function confirmTargetChange(input: {
  client: ApiClient;
  pending: PendingTargetChange;
  onCommitted: SettingsViewProps["onCommitted"];
  onStaleSession: SettingsViewProps["onStaleSession"];
  setDraft: DraftSetter;
  setPending: StateSetter<PendingTargetChange | null>;
  setState: StateSetter<SaveState>;
}): Promise<void> {
  input.setState("saving");
  try {
    const preview = input.pending.preview;
    const result = await input.client.confirmSettingsTargetChange({
      update: input.pending.update,
      expectedSettingsUpdatedAt: preview.expectedSettingsUpdatedAt,
      impactHash: preview.impactHash,
    });
    input.onCommitted(result.settings);
    input.setDraft(result.settings);
    input.setPending(null);
    input.setState("saved");
  } catch (reason) {
    reportStaleSession(reason, input.onStaleSession);
    input.setPending(null);
    input.setState("error");
  }
}

function reportStaleSession(reason: unknown, onStaleSession: () => void): void {
  if (reason instanceof ApiError && reason.category === "stale_session") {
    onStaleSession();
  }
}

function TargetChangeConfirmation({
  pending,
  state,
  confirm,
  cancel,
}: {
  pending: PendingTargetChange;
  state: SaveState;
  confirm: () => void;
  cancel: () => void;
}) {
  const targets = uniqueTargets(pending.preview.targets);
  return (
    <section
      className="settings-impact"
      aria-labelledby="settings-impact-title"
    >
      <p className="eyebrow">تأكيد عالمي مطلوب</p>
      <h2 id="settings-impact-title">ستُنشأ مهام بديلة للعمل المتبقي</h2>
      <p>
        يشمل التغيير {formatQueueNumber(pending.preview.affected.length)} مهمة
        غير منفّذة. المهام الجارية والمكتملة وسجل منشئها لن تتغير.
      </p>
      <TargetChangeList targets={targets} />
      <TargetChangeActions state={state} confirm={confirm} cancel={cancel} />
    </section>
  );
}

function TargetChangeList({
  targets,
}: {
  targets: PendingTargetChange["preview"]["targets"];
}) {
  return (
    <ul>
      {targets.map((target) => (
        <li key={`${target.operation}:${target.providerId}:${target.modelId}`}>
          {operationLabel(target.operation)}: {providerLabel(target.providerId)}
          ، <bdi dir="ltr">{target.modelId}</bdi>
        </li>
      ))}
    </ul>
  );
}

function TargetChangeActions({
  state,
  confirm,
  cancel,
}: {
  state: SaveState;
  confirm: () => void;
  cancel: () => void;
}) {
  const disabled = state === "saving";
  return (
    <div className="settings-impact__actions">
      <button
        className="button button--primary"
        type="button"
        disabled={disabled}
        onClick={confirm}
      >
        تأكيد الحفظ وإنشاء البدائل
      </button>
      <button
        className="button button--secondary"
        type="button"
        disabled={disabled}
        onClick={cancel}
      >
        العودة من دون حفظ
      </button>
    </div>
  );
}

function uniqueTargets(targets: SettingsTargetChangePreview["targets"]) {
  return targets.filter(
    (target, index) =>
      targets.findIndex(
        (candidate) =>
          candidate.operation === target.operation &&
          candidate.providerId === target.providerId &&
          candidate.modelId === target.modelId,
      ) === index,
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
        <PhotoLimitFields {...props} />
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

function PhotoLimitFields({ draft, setDraft }: DraftProps) {
  return (
    <>
      <NumberField
        label="أقصى حجم للصورة، ميجابايت"
        value={draft.photoUploadMaxMb}
        min={1}
        max={100}
        onChange={(value) =>
          setDraft((current) => ({ ...current, photoUploadMaxMb: value }))
        }
      />
      <NumberField
        label="أقصى دقة للصورة، ميجابكسل"
        value={draft.photoMaxMegapixels}
        min={1}
        max={200}
        onChange={(value) =>
          setDraft((current) => ({ ...current, photoMaxMegapixels: value }))
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

function saveMessage(state: SaveState): string {
  if (state === "saved") return "حُفظت الإعدادات على هذا الجهاز.";
  if (state === "error") return "تعذّر الحفظ. راجع حالة النظام وحاول مرة أخرى.";
  return "";
}
