import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import type { ApiClient } from "../../api";
import type {
  GeminiCredentialStatus,
  IllustrationStyleId,
  PromptPolicyCheck,
  ProviderId,
  ProviderStatusSnapshot,
  Settings,
} from "../../types";
import { StatusLine } from "../StatusLine";
import { GeminiCredentialPanel } from "./GeminiCredentialPanel";
import { PromptPolicyConfirmation } from "./PromptPolicyConfirmation";
import { ProviderStatusCard } from "./ProviderStatusCard";

export function ProviderSettingsPanel(props: {
  client: ApiClient;
  draft: Settings;
  setDraft: Dispatch<SetStateAction<Settings>>;
}) {
  const state = useProviderPanelState(props.client);
  const status = state.status;
  return (
    <section
      className="section provider-settings"
      aria-labelledby="provider-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">اتصال صريح ومن دون بدائل تلقائية</p>
          <h2 id="provider-heading">المزوّدون والنماذج</h2>
        </div>
        <span className="status-chip status-chip--ok">متاح محليًا</span>
      </div>
      <div className="status-list deferred-settings">
        <StatusLine label="دورة اتصال المزوّدين" status="متاحة" tone="ok" />
        <StatusLine label="ملفات الطباعة" status="غير مُعَدّة" tone="pending" />
      </div>
      <ProviderConfiguration draft={props.draft} setDraft={props.setDraft} />
      {status && (
        <div className="provider-card-grid">
          {(["mock", "codex", "gemini"] as const).map((providerId) => (
            <ProviderStatusCard
              key={providerId}
              providerId={providerId}
              projection={status.providers[providerId]}
              busy={state.busyProvider === providerId}
              onTest={() => state.testProvider(providerId)}
            />
          ))}
        </div>
      )}
      <GeminiCredentialPanel
        status={state.credential}
        onSave={state.saveCredential}
        onDelete={state.deleteCredential}
      />
      <PromptPolicyWorkspace client={props.client} />
      <output className="notice-error" aria-live="polite">
        {state.error}
      </output>
    </section>
  );
}

function ProviderConfiguration(props: {
  draft: Settings;
  setDraft: Dispatch<SetStateAction<Settings>>;
}) {
  return (
    <div className="form-grid provider-config-grid">
      <ProviderSelect label="مزوّد النص" field="textProvider" {...props} />
      <ProviderSelect label="مزوّد الصور" field="imageProvider" {...props} />
      <TierSelect {...props} />
      {modelFields.map((field) => (
        <label className="field" key={field.key}>
          <span>{field.label}</span>
          <input
            dir="ltr"
            value={props.draft.models[field.key]}
            onChange={(event) =>
              props.setDraft((current) => ({
                ...current,
                models: { ...current.models, [field.key]: event.target.value },
              }))
            }
          />
        </label>
      ))}
    </div>
  );
}

const modelFields: Array<{ key: keyof Settings["models"]; label: string }> = [
  { key: "codexText", label: "معرّف نموذج نص Codex" },
  { key: "geminiText", label: "معرّف نموذج نص Gemini" },
  { key: "geminiImage", label: "معرّف نموذج صور Gemini" },
  { key: "geminiImageEconomy", label: "معرّف نموذج الصور الاقتصادي" },
];

function ProviderSelect(props: {
  label: string;
  field: "textProvider" | "imageProvider";
  draft: Settings;
  setDraft: Dispatch<SetStateAction<Settings>>;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select
        value={props.draft[props.field]}
        onChange={(event) => {
          const provider = providerId(event.target.value);
          props.setDraft((current) => ({
            ...current,
            [props.field]: provider,
          }));
        }}
      >
        <option value="mock">المزوّد التجريبي</option>
        <option value="codex">Codex</option>
        <option value="gemini">Gemini</option>
      </select>
    </label>
  );
}

function TierSelect(props: {
  draft: Settings;
  setDraft: Dispatch<SetStateAction<Settings>>;
}) {
  return (
    <div className="field">
      <label htmlFor="gemini-image-tier">مستوى صور Gemini</label>
      <select
        id="gemini-image-tier"
        value={props.draft.geminiImageTier}
        onChange={(event) =>
          props.setDraft((current) => ({
            ...current,
            geminiImageTier:
              event.target.value === "economy" ? "economy" : "default",
          }))
        }
      >
        <option value="default">افتراضي</option>
        <option value="economy">اقتصادي</option>
      </select>
      {props.draft.geminiImageTier === "economy" && (
        <small className="provider-warning">
          تنبيه: المستوى الاقتصادي قد يقلّل ثبات الشخصيات والتفاصيل.
        </small>
      )}
    </div>
  );
}

function useProviderPanelState(client: ApiClient) {
  const [status, setStatus] = useState<ProviderStatusSnapshot | null>(null);
  const [credential, setCredential] = useState<GeminiCredentialStatus | null>(
    null,
  );
  const [busyProvider, setBusyProvider] = useState<ProviderId | null>(null);
  const [error, setError] = useState("");
  useInitialProviderStatus(client, setStatus, setCredential, setError);
  async function testProvider(providerId: ProviderId) {
    setBusyProvider(providerId);
    setError("");
    try {
      const result = await client.testProvider(providerId);
      setStatus(
        (current) =>
          current && {
            ...current,
            providers: { ...current.providers, [providerId]: result.provider },
          },
      );
    } catch {
      setError("تعذّر فحص المزوّد. راجع الإعداد ثم حاول مرة أخرى.");
    } finally {
      setBusyProvider(null);
    }
  }
  async function saveCredential(key: string) {
    setCredential(await client.saveGeminiCredential(key));
    setStatus((current) => current && resetGemini(current));
  }
  async function deleteCredential() {
    setCredential(await client.deleteGeminiCredential());
    setStatus((current) => current && resetGemini(current));
  }
  return {
    status,
    credential,
    busyProvider,
    error,
    testProvider,
    saveCredential,
    deleteCredential,
  };
}

function useInitialProviderStatus(
  client: ApiClient,
  setStatus: Dispatch<SetStateAction<ProviderStatusSnapshot | null>>,
  setCredential: Dispatch<SetStateAction<GeminiCredentialStatus | null>>,
  setError: Dispatch<SetStateAction<string>>,
): void {
  useEffect(() => {
    let active = true;
    void client
      .providerStatus()
      .then((value) => {
        if (!active) return;
        setStatus(value);
        setCredential(value.credential);
      })
      .catch(() => active && setError("تعذّر تحميل حالة المزوّدين."));
    return () => {
      active = false;
    };
  }, [client, setCredential, setError, setStatus]);
}

function PromptPolicyWorkspace({ client }: { client: ApiClient }) {
  const state = usePromptPolicyState(client);
  return (
    <section
      className="prompt-policy-panel"
      aria-labelledby="prompt-policy-heading"
    >
      <div>
        <p className="eyebrow">فحص قبل الإرسال</p>
        <h3 id="prompt-policy-heading">سياسة الوصف البصري الأصلي</h3>
      </div>
      <PromptPolicyFields state={state} />
      <PromptPolicyOutcome state={state} />
      <output className="notice-error" aria-live="polite">
        {state.error}
      </output>
    </section>
  );
}

function usePromptPolicyState(client: ApiClient) {
  const [prompt, setPrompt] = useState("");
  const [styleId, setStyleId] = useState<IllustrationStyleId>("modern_cartoon");
  const [check, setCheck] = useState<PromptPolicyCheck | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const actions = usePromptPolicyActions(client, {
    prompt,
    styleId,
    check,
    setCheck,
    setConfirmed,
    setBusy,
    setError,
  });
  function changePrompt(value: string) {
    setPrompt(value);
    setCheck(null);
    setConfirmed(false);
  }
  function changeStyle(value: string) {
    setStyleId(styleIdValue(value));
    setCheck(null);
    setConfirmed(false);
  }
  return {
    prompt,
    styleId,
    check,
    confirmed,
    busy,
    error,
    ...actions,
    changePrompt,
    changeStyle,
  };
}

function usePromptPolicyActions(
  client: ApiClient,
  state: {
    prompt: string;
    styleId: IllustrationStyleId;
    check: PromptPolicyCheck | null;
    setCheck: Dispatch<SetStateAction<PromptPolicyCheck | null>>;
    setConfirmed: Dispatch<SetStateAction<boolean>>;
    setBusy: Dispatch<SetStateAction<boolean>>;
    setError: Dispatch<SetStateAction<string>>;
  },
) {
  async function inspect() {
    if (!state.prompt.trim()) return;
    state.setBusy(true);
    try {
      state.setCheck(
        await client.checkPromptPolicy(state.prompt, state.styleId),
      );
      state.setConfirmed(false);
      state.setError("");
    } catch {
      state.setError("تعذّر فحص الوصف.");
    } finally {
      state.setBusy(false);
    }
  }
  async function confirm() {
    if (state.check?.status !== "confirmation_required") return;
    state.setBusy(true);
    try {
      await client.confirmPromptPolicy({
        prompt: state.prompt,
        styleId: state.styleId,
        bindingHash: state.check.bindingHash,
      });
      state.setConfirmed(true);
      state.setError("");
    } catch {
      state.setError("تغيّر الوصف أو انتهت صلاحية التأكيد. افحصه من جديد.");
    } finally {
      state.setBusy(false);
    }
  }
  return { inspect, confirm };
}

type PromptPolicyState = ReturnType<typeof usePromptPolicyState>;

function PromptPolicyFields({ state }: { state: PromptPolicyState }) {
  return (
    <>
      <label className="field">
        <span>وصف بصري للاختبار</span>
        <textarea
          value={state.prompt}
          onChange={(event) => state.changePrompt(event.target.value)}
        />
      </label>
      <label className="field">
        <span>الأسلوب</span>
        <select
          value={state.styleId}
          onChange={(event) => state.changeStyle(event.target.value)}
        >
          <option value="modern_cartoon">كرتون عصري</option>
          <option value="colorful_2d">ثنائي الأبعاد ملوّن</option>
          <option value="soft_watercolor">ألوان مائية ناعمة</option>
        </select>
      </label>
      <button
        className="button button--secondary"
        type="button"
        disabled={state.busy || !state.prompt.trim()}
        onClick={() => void state.inspect()}
      >
        فحص الوصف
      </button>
    </>
  );
}

function PromptPolicyOutcome({ state }: { state: PromptPolicyState }) {
  return (
    <>
      {state.check?.status === "allowed" && (
        <p className="policy-ok" role="status">
          ✓ الوصف أصلي ويمكن استخدامه.
        </p>
      )}
      {state.check?.status === "confirmation_required" && !state.confirmed && (
        <PromptPolicyConfirmation
          check={state.check}
          busy={state.busy}
          onConfirm={state.confirm}
        />
      )}
      {state.confirmed && (
        <p className="policy-ok" role="status">
          ✓ تأكد البديل الأصلي لهذا الإصدار من الوصف.
        </p>
      )}
    </>
  );
}

function resetGemini(status: ProviderStatusSnapshot): ProviderStatusSnapshot {
  return {
    ...status,
    providers: {
      ...status.providers,
      gemini: {
        state: "not_checked",
        checkedAt: null,
        source: null,
        authState: null,
        text: null,
        image: null,
        unavailableReason: null,
      },
    },
  };
}

function providerId(value: string): ProviderId {
  return value === "codex" || value === "gemini" ? value : "mock";
}

function styleIdValue(value: string): IllustrationStyleId {
  if (value === "colorful_2d" || value === "soft_watercolor") return value;
  return "modern_cartoon";
}
