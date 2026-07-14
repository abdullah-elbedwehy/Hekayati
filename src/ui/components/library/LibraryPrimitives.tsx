import type { ReactNode } from "react";

import type { LibraryStatus } from "../../types";

export function EntityStatus({ status }: { status: LibraryStatus }) {
  const archived = status === "archived";
  return (
    <span
      className={`entity-status entity-status--${status}`}
      aria-label={archived ? "الحالة: مؤرشف" : "الحالة: نشط"}
    >
      <span className="entity-status__mark" aria-hidden="true">
        {archived ? "Ⅱ" : "✓"}
      </span>
      {archived ? "مؤرشف" : "نشط"}
    </span>
  );
}

export function InlineNotice({
  tone,
  children,
}: {
  tone: "info" | "warning" | "error" | "success";
  children: ReactNode;
}) {
  return (
    <div className={`inline-notice inline-notice--${tone}`} role="status">
      <span className="inline-notice__mark" aria-hidden="true">
        {noticeMark(tone)}
      </span>
      <div>{children}</div>
    </div>
  );
}

function noticeMark(tone: "info" | "warning" | "error" | "success") {
  if (tone === "success") return "✓";
  if (tone === "error") return "!";
  if (tone === "warning") return "△";
  return "i";
}

export function FormMessage({
  state,
  error,
}: {
  state: "idle" | "saving" | "saved" | "error";
  error?: string;
}) {
  const message =
    state === "saving"
      ? "جارٍ الحفظ محليًا…"
      : state === "saved"
        ? "حُفظ التغيير على هذا الجهاز."
        : state === "error"
          ? error
          : "";
  return (
    <output
      className={`library-form-message library-form-message--${state}`}
      aria-live="polite"
    >
      {message}
    </output>
  );
}

export function EditorActions(props: {
  state: "idle" | "saving" | "saved" | "error";
  error?: string;
  primaryLabel: string;
  primaryDisabled?: boolean;
  onCancel?: () => void;
}) {
  return (
    <div className="library-form-actions">
      <button
        className="button button--primary"
        disabled={props.state === "saving" || props.primaryDisabled}
      >
        {props.primaryLabel}
      </button>
      {props.onCancel ? (
        <button
          className="button button--quiet"
          type="button"
          onClick={props.onCancel}
        >
          إلغاء
        </button>
      ) : null}
      <FormMessage state={props.state} error={props.error} />
    </div>
  );
}

export function DeferredFeatureNote() {
  return (
    <InlineNotice tone="info">
      توليد أوراق الشخصيات واستخدام المظهر داخل مشروع غير متاحين في هذه المرحلة.
      بيانات المكتبة محفوظة وجاهزة لهما لاحقًا.
    </InlineNotice>
  );
}
