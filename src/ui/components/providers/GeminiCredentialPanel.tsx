import { useState } from "react";

import type { GeminiCredentialStatus } from "../../types";

export function GeminiCredentialPanel(props: {
  status: GeminiCredentialStatus | null;
  onSave: (key: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const state = useCredentialPanelState(props);
  return (
    <section className="credential-panel" aria-labelledby="gemini-key-title">
      <CredentialHeader status={props.status} />
      <label className="field" htmlFor="gemini-credential">
        <span id="gemini-key-title">مفتاح Gemini API</span>
        <input
          id="gemini-credential"
          name="geminiCredential"
          type="password"
          autoComplete="off"
          maxLength={512}
          value={state.key}
          onChange={(event) => state.setKey(event.target.value)}
          placeholder={
            props.status?.present ? "أدخل مفتاحًا بديلًا" : "أدخل المفتاح"
          }
        />
      </label>
      <div className="section-actions">
        <button
          className="button button--primary"
          type="button"
          disabled={state.busy || !state.key.trim()}
          onClick={() => void state.save()}
        >
          {props.status?.present ? "استبدال المفتاح" : "حفظ المفتاح"}
        </button>
        {props.status?.present && (
          <DeleteCredentialAction
            armed={state.deleteArmed}
            busy={state.busy}
            onArm={() => state.setDeleteArmed(true)}
            onDelete={state.deleteCredential}
          />
        )}
      </div>
      <output className="save-state" aria-live="polite">
        {state.message}
      </output>
    </section>
  );
}

function useCredentialPanelState(props: {
  onSave: (key: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [message, setMessage] = useState("");
  async function save() {
    if (!key.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      await props.onSave(key);
      setKey("");
      setMessage("حُفظ المفتاح في Keychain.");
    } catch {
      setMessage("تعذّر حفظ المفتاح.");
    } finally {
      setBusy(false);
    }
  }
  async function deleteCredential() {
    setBusy(true);
    try {
      await props.onDelete();
      setDeleteArmed(false);
      setMessage("حُذف المفتاح من Keychain.");
    } catch {
      setMessage("تعذّر حذف المفتاح.");
    } finally {
      setBusy(false);
    }
  }
  return {
    key,
    setKey,
    busy,
    deleteArmed,
    setDeleteArmed,
    message,
    save,
    deleteCredential,
  };
}

function CredentialHeader({
  status,
}: {
  status: GeminiCredentialStatus | null;
}) {
  return (
    <div className="credential-panel__status">
      <strong>
        {status?.present ? "✓ المفتاح موجود" : "○ المفتاح غير موجود"}
      </strong>
      {status?.masked && <bdi aria-label="قيمة مخفية">{status.masked}</bdi>}
      <small>لا يظهر المفتاح ولا يُحفظ في قاعدة البيانات.</small>
    </div>
  );
}

function DeleteCredentialAction(props: {
  armed: boolean;
  busy: boolean;
  onArm: () => void;
  onDelete: () => Promise<void>;
}) {
  return (
    <button
      className="button button--danger"
      type="button"
      disabled={props.busy}
      onClick={() => (props.armed ? void props.onDelete() : props.onArm())}
    >
      {props.armed ? "تأكيد حذف المفتاح" : "حذف المفتاح"}
    </button>
  );
}
