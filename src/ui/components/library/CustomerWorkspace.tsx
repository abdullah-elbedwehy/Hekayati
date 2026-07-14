import { useState, type FormEvent } from "react";

import type { CustomerInput, FamilyInput } from "../../api";
import type {
  ConsentRecord,
  LibraryCustomer,
  LibraryFamily,
} from "../../types";
import { ConsentPanel } from "./ConsentPanel";
import {
  EditorActions,
  EntityStatus,
  FormMessage,
  InlineNotice,
} from "./LibraryPrimitives";
import { libraryError } from "./library-utils";

interface CustomerWorkspaceProps {
  customer: LibraryCustomer;
  families: LibraryFamily[];
  selectedFamilyId?: string;
  onSelectFamily: (id: string) => void;
  onUpdate: (input: CustomerInput) => Promise<void>;
  onVisibility: (action: "archive" | "restore") => Promise<void>;
  onConsent: (consent: ConsentRecord | null) => Promise<void>;
  onCreateFamily: (input: FamilyInput) => Promise<void>;
}

export function CustomerWorkspace(props: CustomerWorkspaceProps) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="customer-workspace">
      <CustomerHeader
        customer={props.customer}
        editing={editing}
        setEditing={setEditing}
        onVisibility={props.onVisibility}
      />
      {editing && (
        <CustomerEditForm
          customer={props.customer}
          onSave={props.onUpdate}
          onDone={() => setEditing(false)}
        />
      )}
      <ConsentPanel customer={props.customer} onSave={props.onConsent} />
      <FamilySection {...props} />
    </div>
  );
}

function CustomerHeader(props: {
  customer: LibraryCustomer;
  editing: boolean;
  setEditing: (value: boolean) => void;
  onVisibility: (action: "archive" | "restore") => Promise<void>;
}) {
  const { customer } = props;
  return (
    <>
      <header className="workspace-heading">
        <div className="workspace-title">
          <div>
            <p className="eyebrow">سجل العميل</p>
            <h2 title={customer.name}>{customer.name}</h2>
          </div>
          <EntityStatus status={customer.status} />
        </div>
        <div className="compact-actions">
          <button
            className="button button--secondary"
            type="button"
            onClick={() => props.setEditing(!props.editing)}
          >
            {props.editing ? "إغلاق التعديل" : "تعديل البيانات"}
          </button>
          <VisibilityButton
            status={customer.status}
            onVisibility={props.onVisibility}
            label="العميل"
          />
        </div>
      </header>
    </>
  );
}

function VisibilityButton(props: {
  status: "active" | "archived";
  onVisibility: (action: "archive" | "restore") => Promise<void>;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const archived = props.status === "archived";
  async function change() {
    setBusy(true);
    setError("");
    try {
      await props.onVisibility(archived ? "restore" : "archive");
    } catch (reason) {
      setError(libraryError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="visibility-action">
      <button
        className="button button--quiet"
        type="button"
        disabled={busy}
        onClick={() => void change()}
      >
        {archived ? `استعادة ${props.label}` : `أرشفة ${props.label}`}
      </button>
      <FormMessage state={error ? "error" : "idle"} error={error} />
    </div>
  );
}

function CustomerEditForm(props: {
  customer: LibraryCustomer;
  onSave: (input: CustomerInput) => Promise<void>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<CustomerInput>(props.customer);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("saving");
    try {
      await props.onSave(draft);
      props.onDone();
    } catch (reason) {
      setError(libraryError(reason));
      setState("error");
    }
  }
  return (
    <form className="inline-editor" onSubmit={(event) => void submit(event)}>
      <CustomerEditFields draft={draft} setDraft={setDraft} />
      <EditorActions state={state} error={error} primaryLabel="حفظ البيانات" />
    </form>
  );
}

function CustomerEditFields(props: {
  draft: CustomerInput;
  setDraft: (draft: CustomerInput) => void;
}) {
  const { draft, setDraft } = props;
  return (
    <>
      <div className="form-grid">
        <label className="field">
          <span>اسم العميل</span>
          <input
            required
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </label>
        <label className="field">
          <span>رقم واتساب</span>
          <input
            dir="ltr"
            inputMode="tel"
            value={draft.whatsapp}
            onChange={(event) =>
              setDraft({ ...draft, whatsapp: event.target.value })
            }
          />
        </label>
      </div>
      <label className="field">
        <span>ملاحظات محلية</span>
        <textarea
          value={draft.notes}
          onChange={(event) =>
            setDraft({ ...draft, notes: event.target.value })
          }
        />
      </label>
    </>
  );
}

function FamilySection(props: CustomerWorkspaceProps) {
  const [creating, setCreating] = useState(props.families.length === 0);
  return (
    <section className="library-subsection" aria-labelledby="families-heading">
      <div className="library-subheading">
        <div>
          <p className="eyebrow">نطاق الخصوصية</p>
          <h3 id="families-heading">العائلات</h3>
        </div>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => setCreating(!creating)}
        >
          {creating ? "إلغاء" : "إضافة عائلة"}
        </button>
      </div>
      <InlineNotice tone="info">
        لا تظهر الشخصيات المرشحة خارج عائلتها، حتى عند استخدام معرّف مباشر.
      </InlineNotice>
      {creating && (
        <NewFamilyForm
          onCreate={props.onCreateFamily}
          onDone={() => setCreating(false)}
        />
      )}
      <FamilyTabs
        families={props.families}
        selectedId={props.selectedFamilyId}
        onSelect={props.onSelectFamily}
      />
    </section>
  );
}

function NewFamilyForm(props: {
  onCreate: (input: FamilyInput) => Promise<void>;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await props.onCreate({ name: name.trim() });
      props.onDone();
    } catch (reason) {
      setError(libraryError(reason));
    }
  }
  return (
    <form className="compact-form" onSubmit={(event) => void submit(event)}>
      <label className="field">
        <span>اسم العائلة</span>
        <input
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="مثال: عائلة محمود"
        />
      </label>
      <button className="button button--primary">حفظ العائلة</button>
      <FormMessage state={error ? "error" : "idle"} error={error} />
    </form>
  );
}

function FamilyTabs(props: {
  families: LibraryFamily[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  if (props.families.length === 0)
    return (
      <p className="empty-copy">
        لا توجد عائلة بعد. إنشاء عائلة لا يضيف أعضاء تلقائيًا.
      </p>
    );
  return (
    <div className="family-tabs" aria-label="عائلات العميل">
      {props.families.map((family) => (
        <button
          aria-pressed={family.id === props.selectedId}
          className="family-tab"
          type="button"
          key={family.id}
          onClick={() => props.onSelect(family.id)}
        >
          <span title={family.name}>{family.name}</span>
          <EntityStatus status={family.status} />
        </button>
      ))}
    </div>
  );
}
