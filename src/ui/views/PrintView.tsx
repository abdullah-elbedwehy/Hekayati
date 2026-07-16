import type { ApiClient } from "../api";
import { PrintProfilePanel } from "../components/print/PrintProfilePanel";
import { PrintRunPanel } from "../components/print/PrintRunPanel";
import { usePrintState } from "./use-print-state";

export function PrintView({ client }: { client: ApiClient }) {
  const state = usePrintState(client);
  return (
    <main className="view print-view" id="main-content">
      <header className="view-header view-header--with-action">
        <div>
          <p className="eyebrow">من النسخة المعتمدة إلى المطبعة</p>
          <h1>الإنتاج الطباعي</h1>
          <p>
            ثبّت هندسة الطابعة، أنتج الداخل والغلاف بلا علامة مائية، ثم راجع
            القياسات وبروفة الألوان قبل التسليم.
          </p>
        </div>
        <button
          className="button button--secondary"
          disabled={state.busy}
          onClick={() => void state.reload()}
        >
          {state.busy ? "جارٍ التحديث…" : "تحديث الحالة"}
        </button>
      </header>
      {state.error ? (
        <p className="print-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <PrintContext state={state} />
      <div className="print-workspace">
        <PrintProfilePanel state={state} />
        {state.familyId && state.projectId && state.snapshot ? (
          <PrintRunPanel client={client} state={state} />
        ) : (
          <section className="print-card print-empty">
            <span aria-hidden="true">ح</span>
            <h2>اختر عائلة ومشروعًا لبدء تجهيز ملفات المطبعة.</h2>
          </section>
        )}
      </div>
    </main>
  );
}

function PrintContext({ state }: { state: ReturnType<typeof usePrintState> }) {
  return (
    <section
      className="preview-context print-context"
      aria-label="اختيار مشروع الطباعة"
    >
      <label className="field">
        <span>العائلة</span>
        <select
          value={state.familyId}
          onChange={(event) => state.selectFamily(event.target.value)}
        >
          <option value="">اختر عائلة</option>
          {state.library?.families
            .filter((item) => item.status === "active")
            .map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
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
          {state.projects.map((item) => (
            <option value={item.project.id} key={item.project.id}>
              {item.version.storyConfig.title}
            </option>
          ))}
        </select>
      </label>
      <p>التنزيلات مربوطة بالعائلة والمشروع والتشغيل الحالي فقط.</p>
    </section>
  );
}
