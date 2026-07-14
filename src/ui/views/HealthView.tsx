import { StatusLine } from "../components/StatusLine";
import type {
  HealthSnapshot,
  IntegrityReport,
  JobHealthSnapshot,
  ProviderProjection,
} from "../types";
import { formatQueueNumber } from "../components/jobs/format";

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
      <ProviderHealth health={props.health} />
      <QueueHealth health={props.health} />
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
    return "تعذّر القياس، راجع مجلد البيانات";
  if (health.disk.status === "warning")
    return `${health.disk.freeGb} جيجابايت، أقل من حد التحذير`;
  return `${health.disk.freeGb} جيجابايت، مساحة كافية`;
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
          <p className="eyebrow">مرحلة الطباعة</p>
          <h2 id="deferred-heading">إعداد لم يكتمل</h2>
        </div>
      </div>
      <div className="status-list">
        <StatusLine label="ملفات الطباعة" status="غير مُعَدّة" tone="pending" />
      </div>
    </section>
  );
}

function QueueHealth({ health }: { health: HealthSnapshot }) {
  if (health.queue.status !== "available") {
    return (
      <section className="section" aria-labelledby="queue-health-heading">
        <h2 id="queue-health-heading">تنفيذ المهام</h2>
        <StatusLine label="قائمة المهام" status="غير متاحة" tone="pending" />
      </section>
    );
  }
  const queue = health.queue;
  return (
    <section className="section" aria-labelledby="queue-health-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">قراءة محلية بلا فحص مزوّد</p>
          <h2 id="queue-health-heading">تنفيذ المهام</h2>
        </div>
      </div>
      <QueueHealthRows queue={queue} />
    </section>
  );
}

function QueueHealthRows({ queue }: { queue: JobHealthSnapshot }) {
  return (
    <div className="status-list">
      <StatusLine
        label="عامل التنفيذ"
        status={workerHealthLabel(queue.workerStatus)}
        tone={workerHealthTone(queue.workerStatus)}
        detail={
          queue.lastRecoveryAt
            ? `آخر استعادة: ${formatDate(queue.lastRecoveryAt)}`
            : "لا توجد استعادة مسجّلة"
        }
      />
      <StatusLine
        label="عمق القائمة"
        status={`${formatQueueNumber(queue.depth)} مهمة`}
        tone={queue.depth > 0 ? "warning" : "ok"}
        detail={queueCounts(queue)}
      />
      <StatusLine
        label="التنفيذ حسب المزوّد"
        status={runningProviders(queue)}
        tone="ok"
      />
      <StatusLine
        label="مهام بلا تقدّم"
        status={formatQueueNumber(queue.stalledCount)}
        tone={queue.stalledCount > 0 ? "warning" : "ok"}
      />
      <StatusLine
        label="حوادث الحصة المفتوحة"
        status={formatQueueNumber(queue.openQuotaIncidents)}
        tone={queue.openQuotaIncidents > 0 ? "warning" : "ok"}
      />
      <StatusLine
        label="حوادث بيانات الاتصال"
        status={formatQueueNumber(queue.openCredentialIncidents)}
        tone={queue.openCredentialIncidents > 0 ? "error" : "ok"}
      />
      <StatusLine
        label="إيقاف التخزين"
        status={queue.storage.active ? "نشط" : "غير نشط"}
        tone={queue.storage.active ? "error" : "ok"}
        detail={queue.storage.reason ?? undefined}
      />
    </div>
  );
}

function workerHealthTone(status: JobHealthSnapshot["workerStatus"]) {
  if (status === "running") return "ok" as const;
  return status === "halted" ? ("error" as const) : ("warning" as const);
}

function queueCounts(queue: JobHealthSnapshot): string {
  return [
    `انتظار ${formatQueueNumber(queue.counts.queued)}`,
    `اعتماد ${formatQueueNumber(queue.counts.blocked)}`,
    `تنفيذ ${formatQueueNumber(queue.counts.running + queue.counts.claimed)}`,
    `توقف ${formatQueueNumber(queue.counts.paused)}`,
    `مراجعة ${formatQueueNumber(queue.counts.waiting_review)}`,
    `فشل ${formatQueueNumber(queue.counts.failed)}`,
  ].join("، ");
}

function runningProviders(queue: JobHealthSnapshot): string {
  const entries = Object.entries(queue.runningByProvider);
  if (entries.length === 0) return "لا توجد مهمة جارية";
  return entries
    .map(([provider, count]) => `${provider}: ${formatQueueNumber(count)}`)
    .join("، ");
}

function workerHealthLabel(status: JobHealthSnapshot["workerStatus"]): string {
  if (status === "running") return "يعمل";
  return status === "halted" ? "متوقف بسبب خطأ" : "متوقف";
}

function ProviderHealth({ health }: { health: HealthSnapshot }) {
  const providers = health.providers;
  if (providers.status !== "available") {
    return (
      <section className="section" aria-labelledby="provider-health-heading">
        <h2 id="provider-health-heading">اتصال المزوّدين</h2>
        <StatusLine
          label="منظومة المزوّدين"
          status="غير مُعَدّة"
          tone="pending"
        />
      </section>
    );
  }
  return (
    <section className="section" aria-labelledby="provider-health-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">لا يبدأ فحصًا تلقائيًا</p>
          <h2 id="provider-health-heading">اتصال المزوّدين</h2>
        </div>
        <span className="plain-badge">
          النص: {providerLabel(providers.selected.text)} · الصور:{" "}
          {providerLabel(providers.selected.image)}
        </span>
      </div>
      <ProviderConnectionRows connections={providers.connections} />
    </section>
  );
}

function ProviderConnectionRows({
  connections,
}: {
  connections: Extract<
    HealthSnapshot["providers"],
    { status: "available" }
  >["connections"];
}) {
  return (
    <div className="status-list">
      {(["mock", "codex", "gemini"] as const).map((providerId) => {
        const projection = connections[providerId];
        return (
          <StatusLine
            key={providerId}
            label={providerLabel(providerId)}
            status={providerStateLabel(projection.state)}
            tone={providerTone(projection.state)}
            detail={<ProviderHealthDetail projection={projection} />}
          />
        );
      })}
    </div>
  );
}

function ProviderHealthDetail({
  projection,
}: {
  projection: ProviderProjection;
}) {
  if (!projection.checkedAt) return <>اختبر الاتصال من الإعدادات</>;
  return (
    <span className="provider-health-detail">
      <span>المصادقة: {providerAuthLabel(projection.authState)}</span>
      <OperationHealth label="النص" operation={projection.text} />
      <OperationHealth label="الصور" operation={projection.image} />
      {projection.image && (
        <span>حدود الصور: {imageLimitsLabel(projection.image)}</span>
      )}
      <span>
        آخر فحص: {formatDate(projection.checkedAt)} ·{" "}
        {providerSourceLabel(projection.source)}
      </span>
      {projection.unavailableReason && (
        <span>السبب العام: {projection.unavailableReason}</span>
      )}
    </span>
  );
}

function OperationHealth(props: {
  label: string;
  operation: ProviderProjection["text"] | ProviderProjection["image"];
}) {
  if (!props.operation) return <span>{props.label}: لم يُفحص</span>;
  return (
    <span>
      {props.label}: {props.operation.available ? "متاح" : "غير متاح"}
      {props.operation.modelId && (
        <>
          {" "}
          · <bdi>{props.operation.modelId}</bdi>
        </>
      )}
      {props.operation.unavailableReason && (
        <> · {props.operation.unavailableReason}</>
      )}
    </span>
  );
}

function providerAuthLabel(state: ProviderProjection["authState"]): string {
  if (state === "ok") return "صالحة";
  if (state === "missing") return "غير مُعَدّة";
  if (state === "expired") return "منتهية أو مرفوضة";
  return state === "error" ? "خطأ" : "لم تُفحص";
}

function imageLimitsLabel(
  image: NonNullable<ProviderProjection["image"]>,
): string {
  if (
    image.maxReferenceImages === null ||
    image.reliableCharacterCount === null
  ) {
    return "غير مقاسة، إنشاء الصور محجوب";
  }
  return [
    image.maxReferenceImages,
    " مرجعًا · ",
    image.reliableCharacterCount,
    " شخصيات موثوقة",
  ].join("");
}

function providerSourceLabel(source: ProviderProjection["source"]): string {
  if (source === "fixture") return "تجريبي محلي";
  if (source === "cache") return "نتيجة مؤقتة";
  return source === "live" ? "فحص مباشر" : "مصدر غير معروف";
}

function providerStateLabel(
  state: "not_checked" | "available" | "unavailable",
) {
  if (state === "available") return "متاح";
  if (state === "unavailable") return "غير متاح";
  return "لم يُفحص";
}

function providerTone(state: "not_checked" | "available" | "unavailable") {
  if (state === "available") return "ok" as const;
  if (state === "unavailable") return "error" as const;
  return "pending" as const;
}

function providerLabel(provider: "mock" | "codex" | "gemini"): string {
  if (provider === "codex") return "Codex";
  if (provider === "gemini") return "Gemini";
  return "تجريبي";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ar-EG-u-nu-latn", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
