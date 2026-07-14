import { useState, type FormEvent } from "react";

import type { CustomerInput } from "../../api";
import type { LibraryCustomer } from "../../types";
import { EditorActions, EntityStatus } from "./LibraryPrimitives";
import { libraryError } from "./library-utils";

interface CustomerRailProps {
  customers: LibraryCustomer[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onCreate: (input: CustomerInput) => Promise<void>;
}

export function CustomerRail(props: CustomerRailProps) {
  const [creating, setCreating] = useState(props.customers.length === 0);
  return (
    <aside className="customer-rail" aria-labelledby="customers-heading">
      <div className="rail-heading">
        <div>
          <p className="eyebrow">الخطوة الأولى</p>
          <h2 id="customers-heading">العملاء</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => setCreating((value) => !value)}
          aria-expanded={creating}
          aria-controls="new-customer-form"
        >
          <span aria-hidden="true">+</span>
          <span className="sr-only">إضافة عميل</span>
        </button>
      </div>
      {creating && (
        <NewCustomerForm
          onCreate={props.onCreate}
          onDone={() => setCreating(false)}
        />
      )}
      <CustomerList {...props} />
    </aside>
  );
}

function CustomerList({ customers, selectedId, onSelect }: CustomerRailProps) {
  if (customers.length === 0)
    return (
      <p className="rail-empty">
        أضف أول عميل، ثم سجّل الموافقة وأنشئ عائلة واحدة أو أكثر.
      </p>
    );
  return (
    <ul className="entity-list" aria-label="قائمة العملاء">
      {customers.map((customer) => (
        <li key={customer.id}>
          <button
            type="button"
            aria-pressed={customer.id === selectedId}
            className={`entity-row${customer.id === selectedId ? " entity-row--selected" : ""}`}
            onClick={() => onSelect(customer.id)}
          >
            <span className="entity-row__main">
              <strong title={customer.name}>{customer.name}</strong>
              <bdi dir="ltr">{customer.whatsapp || "لا يوجد رقم"}</bdi>
            </span>
            <EntityStatus status={customer.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function NewCustomerForm({
  onCreate,
  onDone,
}: {
  onCreate: (input: CustomerInput) => Promise<void>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<CustomerInput>({
    name: "",
    whatsapp: "",
    notes: "",
  });
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("saving");
    try {
      await onCreate(trimCustomer(draft));
      onDone();
    } catch (reason) {
      setError(libraryError(reason));
      setState("error");
    }
  }
  return (
    <form
      id="new-customer-form"
      className="rail-form"
      onSubmit={(event) => void submit(event)}
    >
      <CustomerFields draft={draft} setDraft={setDraft} />
      <EditorActions state={state} error={error} primaryLabel="حفظ العميل" />
    </form>
  );
}

function CustomerFields(props: {
  draft: CustomerInput;
  setDraft: (draft: CustomerInput) => void;
}) {
  const { draft, setDraft } = props;
  return (
    <>
      <label className="field">
        <span>اسم العميل</span>
        <input
          required
          maxLength={120}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label className="field">
        <span>رقم واتساب</span>
        <input
          dir="ltr"
          inputMode="tel"
          maxLength={40}
          value={draft.whatsapp}
          onChange={(event) =>
            setDraft({ ...draft, whatsapp: event.target.value })
          }
        />
      </label>
      <label className="field">
        <span>ملاحظات محلية</span>
        <textarea
          maxLength={1000}
          value={draft.notes}
          onChange={(event) =>
            setDraft({ ...draft, notes: event.target.value })
          }
        />
      </label>
    </>
  );
}

function trimCustomer(input: CustomerInput): CustomerInput {
  return {
    name: input.name.trim(),
    whatsapp: input.whatsapp.trim(),
    notes: input.notes.trim(),
  };
}
