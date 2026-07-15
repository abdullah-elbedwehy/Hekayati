import { useState } from "react";

import type { LayoutApprovalScope } from "../../layout-types";
import type { PreviewState } from "../../views/use-preview-state";
import { approvalLabel, shortId } from "./format";

export function ApprovalPanel({ state }: { state: PreviewState }) {
  const snapshot = state.snapshot!;
  const cycle = snapshot.approval;
  const readyPreview = snapshot.preview?.status === "ready";
  return (
    <section className="preview-panel" aria-labelledby="approval-title">
      <ApprovalHeading state={cycle?.state ?? null} />
      {cycle?.attentionReasons.length ? (
        <p className="preview-attention" role="status">
          ! يحتاج انتباهًا دون محو الاعتماد: {cycle.attentionReasons.join("، ")}
        </p>
      ) : null}
      {cycle?.state === "ready_to_send" && readyPreview ? (
        <button
          className="button button--accent"
          type="button"
          disabled={state.busy}
          onClick={() => void state.approvalAction("sent")}
        >
          سجّلت إرسال هذه النسخة
        </button>
      ) : null}
      {cycle?.state === "preview_sent" && readyPreview ? (
        <SentApprovalActions state={state} />
      ) : null}
      <AuthorizationStatus state={state} />
    </section>
  );
}

function ApprovalHeading({
  state,
}: {
  state: Parameters<typeof approvalLabel>[0];
}) {
  return (
    <div className="preview-section-heading">
      <div>
        <p className="eyebrow">قرار يدوي خارج قائمة المهام</p>
        <h2 id="approval-title">اعتماد العميل</h2>
      </div>
      <span>{approvalLabel(state).text}</span>
    </div>
  );
}

function SentApprovalActions({ state }: { state: PreviewState }) {
  return (
    <div className="preview-approval-actions">
      <button
        className="button button--primary"
        type="button"
        disabled={state.busy}
        onClick={() => void state.approvalAction("approve")}
      >
        تسجيل موافقة العميل
      </button>
      <ChangeRequestForm state={state} />
    </div>
  );
}

function ChangeRequestForm({ state }: { state: PreviewState }) {
  const [notes, setNotes] = useState("");
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [coverSide, setCoverSide] = useState<"" | "front" | "back" | "both">(
    "",
  );
  const scopes = approvalScopes(pageIds, coverSide);
  return (
    <fieldset className="preview-change-request">
      <legend>أو سجّل التعديلات المطلوبة بدقة</legend>
      <label className="field preview-field-wide">
        <span>ملاحظات التعديل</span>
        <textarea
          value={notes}
          maxLength={8000}
          rows={4}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <PageScopeList state={state} selected={pageIds} onChange={setPageIds} />
      <CoverScope value={coverSide} onChange={setCoverSide} />
      <button
        className="button button--danger"
        type="button"
        disabled={state.busy || !notes.trim() || !scopes.length}
        onClick={() => void state.requestChanges(notes, scopes)}
      >
        تسجيل طلب التعديلات وإلغاء بوابة النسخة
      </button>
    </fieldset>
  );
}

function PageScopeList(props: {
  state: PreviewState;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="preview-scope-list" aria-label="صفحات مطلوبة التعديل">
      {props.state.snapshot!.pages.map((page) => (
        <label key={page.pageId}>
          <input
            type="checkbox"
            checked={props.selected.includes(page.pageId)}
            onChange={(event) =>
              props.onChange(
                event.target.checked
                  ? [...props.selected, page.pageId]
                  : props.selected.filter((id) => id !== page.pageId),
              )
            }
          />
          صفحة {page.pageNumber}
        </label>
      ))}
    </div>
  );
}

function CoverScope(props: {
  value: "" | "front" | "back" | "both";
  onChange: (value: "" | "front" | "back" | "both") => void;
}) {
  return (
    <label className="field">
      <span>نطاق الغلاف</span>
      <select
        value={props.value}
        onChange={(event) =>
          props.onChange(event.target.value as typeof props.value)
        }
      >
        <option value="">بلا تعديل غلاف</option>
        <option value="front">الأمامي</option>
        <option value="back">الخلفي</option>
        <option value="both">الوجهان</option>
      </select>
    </label>
  );
}

function AuthorizationStatus({ state }: { state: PreviewState }) {
  const approvalId = state.snapshot!.project.currentContentApprovalId;
  return approvalId ? (
    <p className="preview-authorization">
      ✓ يوجد تفويض محتوى حالي: <bdi>{shortId(approvalId)}</bdi>
    </p>
  ) : (
    <p className="preview-help">لا يوجد تفويض محتوى صالح للطباعة بعد.</p>
  );
}

function approvalScopes(
  pageIds: string[],
  coverSide: "" | "front" | "back" | "both",
): LayoutApprovalScope[] {
  return [
    ...pageIds.map((pageId) => ({ kind: "page" as const, pageId })),
    ...(coverSide ? [{ kind: "cover" as const, side: coverSide }] : []),
  ];
}
