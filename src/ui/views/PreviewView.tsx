import { useState } from "react";

import type { ApiClient } from "../api";
import type {
  LayoutPageProjection,
  LayoutProjectProjection,
} from "../layout-types";
import { AffectedItems } from "../components/preview/AffectedItems";
import { ApprovalPanel } from "../components/preview/ApprovalPanel";
import { CoverEditor } from "../components/preview/CoverEditor";
import { PageInspector } from "../components/preview/PageInspector";
import { PdfProof } from "../components/preview/PdfProof";
import {
  approvalLabel,
  pageKindLabel,
  workflowLabel,
} from "../components/preview/format";
import { usePreviewState, type PreviewState } from "./use-preview-state";

export function PreviewView({ client }: { client: ApiClient }) {
  const state = usePreviewState(client);
  return (
    <main className="view preview-view" id="main-content">
      <PreviewHeader state={state} />
      {state.error ? (
        <p className="preview-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <PreviewContext state={state} />
      <PreviewBody client={client} state={state} />
    </main>
  );
}

function PreviewHeader({ state }: { state: PreviewState }) {
  return (
    <header className="view-header view-header--with-action preview-header">
      <div>
        <p className="eyebrow">من الصفحات المقفلة إلى اعتماد العميل</p>
        <h1>المعاينة والاعتماد</h1>
        <p>
          راجع ترتيب الكتاب العربي، نزّل ملف المعاينة المائي، وسجّل القرار على
          النسخة الدقيقة.
        </p>
      </div>
      <button
        className="button button--secondary"
        type="button"
        disabled={state.busy}
        onClick={() => void state.reload()}
      >
        {state.busy ? "جارٍ التحديث…" : "تحديث الحالة"}
      </button>
    </header>
  );
}

function PreviewContext({ state }: { state: PreviewState }) {
  return (
    <section className="preview-context" aria-label="اختيار كتاب المعاينة">
      <label className="field">
        <span>العائلة</span>
        <select
          value={state.familyId}
          onChange={(event) => state.selectFamily(event.target.value)}
        >
          <option value="">اختر عائلة</option>
          {state.library?.families
            .filter((family) => family.status === "active")
            .map((family) => (
              <option key={family.id} value={family.id}>
                {family.name}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        <span>المشروع</span>
        <select
          value={state.projectId}
          disabled={!state.familyId}
          onChange={(event) => state.selectProject(event.target.value)}
        >
          <option value="">اختر مشروعًا</option>
          {state.projects.map((workspace) => (
            <option key={workspace.project.id} value={workspace.project.id}>
              {workspace.version.storyConfig.title}
            </option>
          ))}
        </select>
      </label>
      <p>كل قرار هنا مربوط بعائلة ونسخة وملف معاينة محدد.</p>
    </section>
  );
}

function PreviewBody({
  client,
  state,
}: {
  client: ApiClient;
  state: PreviewState;
}) {
  if (!state.familyId)
    return <PreviewEmpty text="اختر عائلة لعرض كتبها الجاهزة للمعاينة." />;
  if (!state.projectId)
    return <PreviewEmpty text="لا يوجد مشروع مختار داخل هذه العائلة." />;
  if (!state.snapshot)
    return <PreviewEmpty text="جارٍ تحميل حالة التنسيق والمعاينة…" busy />;
  return <PreviewWorkspace client={client} state={state} />;
}

function PreviewWorkspace({
  client,
  state,
}: {
  client: ApiClient;
  state: PreviewState;
}) {
  const snapshot = state.snapshot!;
  const [selectedPageId, setSelectedPageId] = useState("");
  const selectedPage =
    snapshot.pages.find((page) => page.pageId === selectedPageId) ??
    snapshot.pages[0];
  return (
    <div className="preview-workspace">
      <PreviewStatus snapshot={snapshot} />
      <PageRail
        pages={snapshot.pages}
        selectedPageId={selectedPage?.pageId ?? ""}
        onSelect={setSelectedPageId}
      />
      <div className="preview-main-grid">
        <div className="preview-editor-column">
          {selectedPage ? (
            <PageInspector
              key={`${selectedPage.pageId}:${selectedPage.layout?.id ?? "none"}`}
              page={selectedPage}
              state={state}
            />
          ) : null}
          {snapshot.cover ? (
            <CoverEditor key={snapshot.cover.id} state={state} />
          ) : null}
          <AffectedItems affected={state.affected} />
        </div>
        <div className="preview-proof-column">
          <PdfProof client={client} state={state} />
          <ApprovalPanel state={state} />
        </div>
      </div>
    </div>
  );
}

function PreviewStatus({ snapshot }: { snapshot: LayoutProjectProjection }) {
  const workflow = workflowLabel(snapshot.workflow?.state ?? null);
  const approval = approvalLabel(snapshot.approval?.state ?? null);
  return (
    <section className="preview-status-grid" aria-label="حالة نسخة الكتاب">
      <StatusFact label="المسار" icon={workflow.icon} value={workflow.text} />
      <StatusFact
        label="ملف المعاينة"
        icon={snapshot.preview?.status === "ready" ? "✓" : "!"}
        value={snapshot.preview?.status === "ready" ? "جاهز" : "غير جاهز"}
      />
      <StatusFact
        label="قرار العميل"
        icon={approval.icon}
        value={approval.text}
      />
      <StatusFact
        label="نسخة الكتاب"
        icon="#"
        value={String(snapshot.project.bookVersion)}
      />
      {snapshot.workflow?.blockingReasons.length ? (
        <p className="preview-status-alert" role="status">
          <span aria-hidden="true">!</span> يحتاج إجراء:{" "}
          {snapshot.workflow.blockingReasons.join("، ")}
        </p>
      ) : null}
    </section>
  );
}

function StatusFact(props: { label: string; icon: string; value: string }) {
  return (
    <div className="preview-status-fact">
      <span className="preview-status-icon" aria-hidden="true">
        {props.icon}
      </span>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function PageRail(props: {
  pages: LayoutPageProjection[];
  selectedPageId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="preview-page-rail" aria-labelledby="page-rail-title">
      <div className="preview-section-heading">
        <div>
          <p className="eyebrow">ترتيب الداخل</p>
          <h2 id="page-rail-title">صفحات الكتاب</h2>
        </div>
        <span>{props.pages.length} صفحة</span>
      </div>
      <div className="preview-page-list" role="list">
        {props.pages.map((page) => (
          <PageRailItem
            key={page.pageId}
            page={page}
            active={page.pageId === props.selectedPageId}
            onSelect={props.onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function PageRailItem(props: {
  page: LayoutPageProjection;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const page = props.page;
  return (
    <div className="preview-page-item" role="listitem">
      <button
        className={`preview-page-card${props.active ? " preview-page-card--active" : ""}`}
        type="button"
        onClick={() => props.onSelect(page.pageId)}
      >
        <span className="preview-page-number">{page.pageNumber}</span>
        <strong>{pageKindLabel(page.kind)}</strong>
        <span>
          {page.layout?.acceptance === "ready" ? "✓ جاهزة" : "! تحتاج عملًا"}
        </span>
      </button>
    </div>
  );
}

function PreviewEmpty({
  text,
  busy = false,
}: {
  text: string;
  busy?: boolean;
}) {
  return (
    <section className="preview-empty" aria-busy={busy}>
      <span aria-hidden="true">{busy ? "…" : "ح"}</span>
      <h2>{text}</h2>
    </section>
  );
}
