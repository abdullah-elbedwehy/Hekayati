import type { ApiClient } from "../../api";
import type { LayoutPreviewOutput } from "../../layout-types";
import type { PreviewState } from "../../views/use-preview-state";
import { formatBytes, shortHash } from "./format";

export function PdfProof({
  client,
  state,
}: {
  client: ApiClient;
  state: PreviewState;
}) {
  const preview = state.snapshot!.preview;
  const ready = preview?.status === "ready";
  const url = ready
    ? client.layoutPreviewPdfUrl(state.familyId, preview.id)
    : "";
  return (
    <section
      className="preview-panel preview-pdf-panel"
      aria-labelledby="pdf-proof-title"
    >
      <PdfHeading ready={ready} />
      {ready ? (
        <ReadyProof preview={preview} state={state} url={url} />
      ) : (
        <EmptyProof />
      )}
    </section>
  );
}

function PdfHeading({ ready }: { ready: boolean }) {
  return (
    <div className="preview-section-heading">
      <div>
        <p className="eyebrow">نفس ملف العميل</p>
        <h2 id="pdf-proof-title">دليل المعاينة</h2>
      </div>
      {ready ? (
        <span className="preview-chip preview-chip--ready">✓ صالح للتنزيل</span>
      ) : null}
    </div>
  );
}

function ReadyProof(props: {
  preview: LayoutPreviewOutput;
  state: PreviewState;
  url: string;
}) {
  return (
    <>
      <iframe
        className="preview-pdf-frame"
        src={props.url}
        title="ملف معاينة الكتاب المائي"
      />
      <div className="preview-proof-actions">
        <a className="button button--primary" href={props.url} download>
          تنزيل ملف المعاينة
        </a>
        <button
          className="button button--secondary"
          type="button"
          disabled={props.state.busy || !props.state.snapshot!.workflow}
          onClick={() => void props.state.regenerate()}
        >
          إعادة إنتاج المعاينة
        </button>
      </div>
      <PdfFacts preview={props.preview} />
    </>
  );
}

function PdfFacts({ preview }: { preview: LayoutPreviewOutput }) {
  return (
    <dl className="preview-facts preview-facts--proof">
      <Fact
        label="عدد الصفحات مع الغلاف"
        value={preview.validationReport.pageCount}
      />
      <Fact label="الحجم" value={formatBytes(preview.validationReport.bytes)} />
      <Fact
        label="منع الاتصالات"
        value={
          preview.validationReport.egressRequestCount === 0 ? "✓ صفر" : "! راجع"
        }
      />
      <Fact
        label="بصمة النسخة"
        value={shortHash(preview.previewSnapshotHash)}
        bidi
      />
    </dl>
  );
}

function Fact(props: {
  label: string;
  value: string | number;
  bidi?: boolean;
}) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.bidi ? <bdi>{props.value}</bdi> : props.value}</dd>
    </div>
  );
}

function EmptyProof() {
  return (
    <div className="preview-proof-empty">
      <span aria-hidden="true">…</span>
      <strong>لا يوجد ملف حالي صالح للعرض</strong>
      <p>تابع حالة المسار والتحذيرات. لا يُعرض ملف قديم على أنه جاهز.</p>
    </div>
  );
}
