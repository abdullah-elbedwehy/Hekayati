import { useState, type FormEvent } from "react";

import type { ConsentRecord, LibraryCustomer } from "../../types";
import { FormMessage, InlineNotice } from "./LibraryPrimitives";
import { formatLibraryDate, libraryError } from "./library-utils";

type Decision = "not_recorded" | "granted" | "refused";
type SaveState = "idle" | "saving" | "saved" | "error";

interface ConsentPanelProps {
  customer: LibraryCustomer;
  onSave: (consent: ConsentRecord | null) => Promise<void>;
}

export function ConsentPanel({ customer, onSave }: ConsentPanelProps) {
  const [saved, setSaved] = useState(false);
  async function save(consent: ConsentRecord | null) {
    setSaved(false);
    await onSave(consent);
    setSaved(true);
  }
  return (
    <section className="library-subsection" aria-labelledby="consent-heading">
      <ConsentHeading consent={customer.consent} />
      <ConsentEditor
        key={consentKey(customer.consent)}
        consent={customer.consent}
        onSave={save}
        onDirty={() => setSaved(false)}
      />
      {saved ? <FormMessage state="saved" /> : null}
      <ConsentConsequence consent={customer.consent} />
    </section>
  );
}

interface ConsentFormProps {
  decision: Decision;
  date: string;
  note: string;
  state: SaveState;
  error: string;
  edit: (update: () => void) => void;
  setDecision: (value: Decision) => void;
  setDate: (value: string) => void;
  setNote: (value: string) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
}

function ConsentForm(props: ConsentFormProps) {
  return (
    <form
      className="consent-form"
      onSubmit={(event) => void props.onSubmit(event)}
    >
      <DecisionFields
        decision={props.decision}
        setDecision={(value) => props.edit(() => props.setDecision(value))}
      />
      {props.decision !== "not_recorded" ? (
        <ConsentDetails
          date={props.date}
          note={props.note}
          setDate={(value) => props.edit(() => props.setDate(value))}
          setNote={(value) => props.edit(() => props.setNote(value))}
        />
      ) : null}
      <div className="library-form-actions">
        <button
          className="button button--primary"
          disabled={props.state === "saving"}
        >
          حفظ قرار الموافقة
        </button>
        <FormMessage state={props.state} error={props.error} />
      </div>
    </form>
  );
}

function UnsavedConsentNotice() {
  return (
    <InlineNotice tone="warning">
      هذا تعديل غير محفوظ. تظل سياسة الصور مبنية على القرار المسجّل أدناه حتى
      تضغط «حفظ قرار الموافقة».
    </InlineNotice>
  );
}

function ConsentEditor(props: {
  consent: ConsentRecord | null;
  onSave: (consent: ConsentRecord | null) => Promise<void>;
  onDirty: () => void;
}) {
  const [decision, setDecision] = useState(decisionOf(props.consent));
  const [date, setDate] = useState(dateValue(props.consent));
  const [note, setNote] = useState(props.consent?.note ?? "");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const dirty = consentDraftDiffers(props.consent, decision, date, note);
  function edit(update: () => void) {
    update();
    setState("idle");
    setError("");
    props.onDirty();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("saving");
    try {
      await props.onSave(toConsent(decision, date, note));
    } catch (reason) {
      setError(libraryError(reason));
      setState("error");
    }
  }
  return (
    <>
      <ConsentForm
        decision={decision}
        date={date}
        note={note}
        state={state}
        error={error}
        edit={edit}
        setDecision={setDecision}
        setDate={setDate}
        setNote={setNote}
        onSubmit={submit}
      />
      {dirty ? <UnsavedConsentNotice /> : null}
    </>
  );
}

function ConsentHeading({ consent }: { consent: ConsentRecord | null }) {
  const status = !consent
    ? "غير مسجّل"
    : consent.granted
      ? "ممنوح"
      : "غير ممنوح";
  return (
    <div className="library-subheading">
      <div>
        <p className="eyebrow">سجل مستقل</p>
        <h3 id="consent-heading">موافقة استخدام الصور</h3>
      </div>
      <span className="consent-summary">
        <span aria-hidden="true">{consent?.granted ? "✓" : "!"}</span>
        {status}
        {consent ? <small>{formatLibraryDate(consent.date)}</small> : null}
      </span>
    </div>
  );
}

function DecisionFields({
  decision,
  setDecision,
}: {
  decision: Decision;
  setDecision: (value: Decision) => void;
}) {
  return (
    <fieldset className="choice-fieldset">
      <legend>تعديل القرار</legend>
      <label>
        <input
          type="radio"
          name="photo-consent-decision"
          checked={decision === "not_recorded"}
          onChange={() => setDecision("not_recorded")}
        />{" "}
        لم يُسجّل قرار
      </label>
      <label>
        <input
          type="radio"
          name="photo-consent-decision"
          checked={decision === "granted"}
          onChange={() => setDecision("granted")}
        />{" "}
        موافقة ممنوحة
      </label>
      <label>
        <input
          type="radio"
          name="photo-consent-decision"
          checked={decision === "refused"}
          onChange={() => setDecision("refused")}
        />{" "}
        موافقة غير ممنوحة
      </label>
    </fieldset>
  );
}

function ConsentDetails(props: {
  date: string;
  note: string;
  setDate: (value: string) => void;
  setNote: (value: string) => void;
}) {
  return (
    <div className="form-grid">
      <label className="field">
        <span>تاريخ القرار</span>
        <input
          type="date"
          required
          value={props.date}
          onChange={(event) => props.setDate(event.target.value)}
        />
      </label>
      <label className="field">
        <span>ملاحظة القرار</span>
        <input
          required
          maxLength={500}
          value={props.note}
          onChange={(event) => props.setNote(event.target.value)}
          placeholder="مثال: سُجّلت الموافقة في المحادثة"
        />
      </label>
    </div>
  );
}

function ConsentConsequence({ consent }: { consent: ConsentRecord | null }) {
  if (consent?.granted)
    return (
      <InlineNotice tone="success">
        يسمح القرار المسجّل بطلب إرسال المراجع المصوّرة لاحقًا، مع إعادة التحقق
        قبل كل إرسال.
      </InlineNotice>
    );
  const code =
    consent === null
      ? "PHOTO_CONSENT_NOT_RECORDED"
      : "PHOTO_CONSENT_NOT_GRANTED";
  return (
    <InlineNotice tone="warning">
      يبقى حفظ الصور محليًا مسموحًا، لكن أي إرسال لاحق سيُحظر. <bdi>{code}</bdi>
    </InlineNotice>
  );
}

function consentDraftDiffers(
  consent: ConsentRecord | null,
  decision: Decision,
  date: string,
  note: string,
): boolean {
  if (decision !== decisionOf(consent)) return true;
  if (decision === "not_recorded") return false;
  return date !== dateValue(consent) || note.trim() !== (consent?.note ?? "");
}

function consentKey(consent: ConsentRecord | null): string {
  return consent
    ? `${String(consent.granted)}:${consent.date}:${consent.note}`
    : "not-recorded";
}

function decisionOf(consent: ConsentRecord | null): Decision {
  if (!consent) return "not_recorded";
  return consent.granted ? "granted" : "refused";
}

function dateValue(consent: ConsentRecord | null): string {
  if (consent) return consent.date.slice(0, 10);
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function toConsent(decision: Decision, date: string, note: string) {
  if (decision === "not_recorded") return null;
  return {
    granted: decision === "granted",
    date: new Date(`${date}T12:00:00`).toISOString(),
    note: note.trim(),
  };
}
