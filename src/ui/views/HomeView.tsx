import { StatusLine } from "../components/StatusLine";
import type { View } from "../App";
import type { HealthSnapshot } from "../types";

interface HomeViewProps {
  health: HealthSnapshot;
  onNavigate: (view: View) => void;
}

export function HomeView({ health, onNavigate }: HomeViewProps) {
  return (
    <main className="view" id="main-content">
      <header className="view-header">
        <p className="eyebrow">مساحة العمل المحلية</p>
        <h1>أساس هادئ لكل حكاية</h1>
        <p>
          سجّل العميل والموافقة، ثم ابنِ شخصيات قابلة لإعادة الاستخدام من دون
          الحاجة إلى إعداد أي مزوّد ذكاء اصطناعي.
        </p>
      </header>
      <Welcome onNavigate={onNavigate} />
      <FoundationStatus health={health} />
    </main>
  );
}

function Welcome({ onNavigate }: Pick<HomeViewProps, "onNavigate">) {
  return (
    <section className="brand-welcome" aria-labelledby="welcome-title">
      <div>
        <span className="brand-kicker">حكايتي</span>
        <h2 id="welcome-title">ورشة كتب آمنة ومضيئة</h2>
        <p>
          الصور الأصلية تبقى في مساحة محلية خاصة. تعرض الواجهة نسخًا مشتقة
          ونظيفة فقط، وتبقى صناعة أوراق الشخصيات والكتب خطوة لاحقة واضحة.
        </p>
        <div className="action-row">
          <button
            className="button button--accent"
            onClick={() => onNavigate("library")}
          >
            افتح مكتبة العائلات
          </button>
          <button
            className="button button--on-leaf"
            onClick={() => onNavigate("settings")}
          >
            راجع الإعدادات
          </button>
          <button
            className="button button--on-leaf"
            onClick={() => onNavigate("queue")}
          >
            تابع قائمة المهام
          </button>
          <button
            className="button button--on-leaf"
            onClick={() => onNavigate("health")}
          >
            افتح حالة النظام
          </button>
        </div>
      </div>
      <div className="brand-mark" aria-hidden="true">
        ح
      </div>
    </section>
  );
}

function FoundationStatus({ health }: Pick<HomeViewProps, "health">) {
  const databaseOk = health.database.status === "ok";
  const listenerOk = health.listener.status === "ok";
  return (
    <section className="section" aria-labelledby="foundation-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">الأساس المحلي</p>
          <h2 id="foundation-title">ما يعمل الآن</h2>
        </div>
        <span className="plain-badge">لا يحتاج إلى مزوّد ذكاء اصطناعي</span>
      </div>
      <div className="status-list">
        <StatusLine
          label="قاعدة البيانات"
          status={databaseOk ? "تعمل" : "تحتاج إلى فحص"}
          tone={databaseOk ? "ok" : "error"}
        />
        <StatusLine
          label="الاستماع المحلي"
          status={listenerOk ? "مقيّد بالجهاز" : "غير جاهز"}
          tone={listenerOk ? "ok" : "error"}
          detail={<bdi>{health.listener.canonicalOrigin ?? "غير متاح"}</bdi>}
        />
        <StatusLine
          label="مكتبة العائلات"
          status="جاهزة للعمل المحلي"
          tone="ok"
        />
        <DynamicStatusLines health={health} />
      </div>
    </section>
  );
}

function DynamicStatusLines({ health }: { health: HealthSnapshot }) {
  const providersReady = health.providers.status === "available";
  const queueRunning =
    health.queue.status === "available" &&
    health.queue.workerStatus === "running";
  return (
    <>
      <StatusLine
        label="المزوّدون"
        status={providersReady ? "حالتهم ظاهرة في التشخيص" : "غير مُعَدّين بعد"}
        tone={providersReady ? "ok" : "pending"}
      />
      <StatusLine
        label="قائمة المهام"
        status={queueSummary(health)}
        tone={queueRunning ? "ok" : "warning"}
      />
    </>
  );
}

function queueSummary(health: HealthSnapshot): string {
  if (health.queue.status !== "available") return "غير متاحة";
  const depth = new Intl.NumberFormat("ar-EG-u-nu-latn").format(
    health.queue.depth,
  );
  return `${depth} مهمة، العامل ${health.queue.workerStatus === "running" ? "يعمل" : "متوقف"}`;
}
