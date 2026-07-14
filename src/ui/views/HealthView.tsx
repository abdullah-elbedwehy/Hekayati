import { StatusLine } from "../components/StatusLine";
import type { HealthSnapshot, IntegrityReport } from "../types";

interface HealthViewProps {
  health: HealthSnapshot;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onScan: () => Promise<void>;
}

export function HealthView(props: HealthViewProps) {
  return (
    <main className="view" id="main-content">
      <HealthHeader busy={props.busy} onRefresh={props.onRefresh} />
      <LocalHealthSection {...props} />
      <DeferredHealth />
    </main>
  );
}

function HealthHeader({
  busy,
  onRefresh,
}: Pick<HealthViewProps, "busy" | "onRefresh">) {
  return (
    <header className="view-header view-header--with-action">
      <div>
        <p className="eyebrow">تشخيص صريح</p>
        <h1>حالة النظام</h1>
        <p>
          كل مكوّن غير موجود بعد يظهر كغير مُعَدّ أو غير متاح، وليس كحالة نجاح.
        </p>
      </div>
      <button
        className="button button--secondary"
        onClick={() => void onRefresh()}
        disabled={busy}
      >
        تحديث الحالة
      </button>
    </header>
  );
}

function LocalHealthSection({ health, busy, onScan }: HealthViewProps) {
  return (
    <section className="section" aria-labelledby="health-local-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">يعمل محليًا</p>
          <h2 id="health-local-heading">التخزين والاستماع</h2>
        </div>
        <time dateTime={health.checkedAt}>{formatDate(health.checkedAt)}</time>
      </div>
      <StorageStatus health={health} />
      <IntegrityIssues integrity={health.integrity} />
      <div className="section-actions">
        <button
          className="button button--secondary"
          onClick={() => void onScan()}
          disabled={busy}
        >
          فحص الملفات الآن
        </button>
        <span className="quiet-note">
          الفحص يبلّغ فقط، ولا يعيد التوليد أو يغيّر الملفات.
        </span>
      </div>
    </section>
  );
}

function StorageStatus({ health }: Pick<HealthViewProps, "health">) {
  const databaseOk = health.database.status === "ok";
  const listenerOk = health.listener.status === "ok";
  const integrityOk = health.integrity.issues.length === 0;
  const diskValue = diskStatusText(health);
  return (
    <div className="status-list">
      <StatusLine
        label="قاعدة البيانات"
        status={databaseOk ? "سليمة" : "خطأ"}
        tone={databaseOk ? "ok" : "error"}
      />
      <StatusLine
        label="المساحة الحرة"
        status={diskValue}
        tone={health.disk.status}
        detail={`يظهر التحذير تحت ${health.disk.thresholdGb} جيجابايت`}
      />
      <StatusLine
        label="عنوان الاستماع"
        status={listenerOk ? "مقيّد بالجهاز" : "غير آمن"}
        tone={listenerOk ? "ok" : "error"}
        detail={<bdi>{health.listener.canonicalOrigin ?? "غير متاح"}</bdi>}
      />
      <StatusLine
        label="سلامة الملفات"
        status={
          integrityOk
            ? `${health.integrity.healthy} ملف سليم`
            : `${health.integrity.issues.length} مشكلة`
        }
        tone={integrityOk ? "ok" : "error"}
        detail={`آخر فحص: ${formatDate(health.integrity.scannedAt)}`}
      />
    </div>
  );
}

function diskStatusText(health: HealthSnapshot): string {
  if (health.disk.status === "error" || health.disk.freeGb === null)
    return "تعذّر القياس — راجع مجلد البيانات";
  if (health.disk.status === "warning")
    return `${health.disk.freeGb} جيجابايت — أقل من حد التحذير`;
  return `${health.disk.freeGb} جيجابايت — مساحة كافية`;
}

function IntegrityIssues({ integrity }: { integrity: IntegrityReport }) {
  if (integrity.issues.length === 0) return null;
  return (
    <div
      className="integrity-report"
      aria-labelledby="integrity-issues-heading"
    >
      <h3 id="integrity-issues-heading">الملفات المتأثرة</h3>
      <ul>
        {integrity.issues.map((issue) => (
          <li key={issue.assetId}>
            <bdi className="integrity-id" title={issue.assetId}>
              {issue.assetId}
            </bdi>
            <span>
              {issue.reason === "missing"
                ? "الملف غير موجود"
                : "بصمة الملف لا تطابق السجل"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeferredHealth() {
  return (
    <section className="section" aria-labelledby="deferred-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">مراحل لاحقة</p>
          <h2 id="deferred-heading">حالات غير مكتملة</h2>
        </div>
      </div>
      <div className="status-list">
        <StatusLine
          label="اتصال المزوّدين"
          status="غير مُعَدّ"
          tone="pending"
        />
        <StatusLine label="عمق قائمة المهام" status="غير متاح" tone="pending" />
        <StatusLine label="ملفات الطباعة" status="غير مُعَدّة" tone="pending" />
      </div>
    </section>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ar-EG-u-nu-latn", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
