import { useEffect, useState } from "react";

import { ApiClient, ApiError, toSettingsUpdate } from "./api";
import type { HealthSnapshot, Settings } from "./types";
import { HealthView } from "./views/HealthView";
import { HomeView } from "./views/HomeView";
import { LibraryView } from "./views/LibraryView";
import { ProjectsView } from "./views/ProjectsView";
import { SettingsView } from "./views/SettingsView";

export type View = "home" | "library" | "projects" | "settings" | "health";
type ErrorCategory = "connect" | "stale";

const navigation = [
  { id: "home" as const, label: "البداية" },
  { id: "library" as const, label: "مكتبة العائلات" },
  { id: "projects" as const, label: "المشاريع والقصص" },
  { id: "settings" as const, label: "الإعدادات" },
  { id: "health" as const, label: "حالة النظام" },
];

export function App() {
  const state = useAppState();
  if (state.error) return <FailureView stale={state.error === "stale"} />;
  if (!state.client || !state.settings || !state.health) return <LoadingView />;
  return (
    <ApplicationShell
      client={state.client}
      settings={state.settings}
      health={state.health}
      view={state.view}
      busy={state.busy}
      setView={state.setView}
      save={state.save}
      refreshHealth={state.refreshHealth}
      acknowledgeBackup={state.acknowledgeBackup}
      backupState={state.backupState}
    />
  );
}

function useAppState() {
  const data = useBootstrap();
  const [view, setView] = useState<View>("home");
  const [busy, setBusy] = useState(false);
  async function save(next: Settings) {
    if (!data.client) throw new Error("API_NOT_READY");
    try {
      data.setSettings(
        await data.client.updateSettings(toSettingsUpdate(next)),
      );
    } catch (reason) {
      if (category(reason) === "stale") data.setError("stale");
      throw reason;
    }
  }
  async function refreshHealth(scan = false) {
    if (!data.client) return;
    setBusy(true);
    try {
      if (scan) await data.client.scanIntegrity();
      data.setHealth(await data.client.health());
    } catch (reason) {
      data.setError(category(reason));
    } finally {
      setBusy(false);
    }
  }
  const backup = useBackupAcknowledgement(data.settings, save);
  return { ...data, view, setView, busy, save, refreshHealth, ...backup };
}

function useBackupAcknowledgement(
  settings: Settings | null,
  save: (settings: Settings) => Promise<void>,
) {
  const [backupState, setBackupState] = useState<"idle" | "saving" | "error">(
    "idle",
  );
  async function acknowledgeBackup() {
    if (!settings) return;
    setBackupState("saving");
    try {
      await save({ ...settings, firstRunAcknowledged: true });
      setBackupState("idle");
    } catch {
      setBackupState("error");
    }
  }
  return { backupState, acknowledgeBackup };
}

function useBootstrap() {
  const [client, setClient] = useState<ApiClient | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState<ErrorCategory | null>(null);
  useEffect(() => {
    void loadBootstrap()
      .then((loaded) => {
        setClient(loaded.client);
        setSettings(loaded.settings);
        setHealth(loaded.health);
      })
      .catch((reason: unknown) => setError(category(reason)));
  }, []);
  return { client, settings, health, error, setSettings, setHealth, setError };
}

async function loadBootstrap() {
  const client = await ApiClient.connect();
  const [settings, health] = await Promise.all([
    client.settings(),
    client.health(),
  ]);
  return { client, settings, health };
}

interface ShellProps {
  client: ApiClient;
  settings: Settings;
  health: HealthSnapshot;
  view: View;
  busy: boolean;
  setView: (view: View) => void;
  save: (settings: Settings) => Promise<void>;
  refreshHealth: (scan?: boolean) => Promise<void>;
  acknowledgeBackup: () => Promise<void>;
  backupState: "idle" | "saving" | "error";
}

function ApplicationShell(props: ShellProps) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        انتقل إلى المحتوى
      </a>
      <div className="shell-grid">
        <Sidebar view={props.view} setView={props.setView} />
        <div className="content-column">
          {!props.settings.firstRunAcknowledged && (
            <FirstRunNotice
              onAcknowledge={() => void props.acknowledgeBackup()}
              state={props.backupState}
            />
          )}
          <CurrentView {...props} />
        </div>
      </div>
    </div>
  );
}

function Sidebar({
  view,
  setView,
}: {
  view: View;
  setView: (v: View) => void;
}) {
  return (
    <aside className="sidebar" aria-label="التنقل الرئيسي">
      <div className="wordmark">
        <span className="wordmark-mark" aria-hidden="true">
          ح
        </span>
        <div>
          <strong>حكايتي</strong>
          <span>ورشة الكتب المحلية</span>
        </div>
      </div>
      <nav>
        {navigation.map((item) => (
          <button
            className={
              view === item.id ? "nav-item nav-item--active" : "nav-item"
            }
            key={item.id}
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <span className="local-indicator" aria-hidden="true" />
        <span>محلي على هذا الجهاز</span>
      </div>
    </aside>
  );
}

function CurrentView(props: ShellProps) {
  if (props.view === "home")
    return <HomeView health={props.health} onNavigate={props.setView} />;
  if (props.view === "library") return <LibraryView client={props.client} />;
  if (props.view === "projects") return <ProjectsView client={props.client} />;
  if (props.view === "settings")
    return (
      <SettingsView
        client={props.client}
        settings={props.settings}
        onSave={props.save}
      />
    );
  return (
    <HealthView
      health={props.health}
      busy={props.busy}
      onRefresh={() => props.refreshHealth(false)}
      onScan={() => props.refreshHealth(true)}
    />
  );
}

function FirstRunNotice({
  onAcknowledge,
  state,
}: {
  onAcknowledge: () => void;
  state: "idle" | "saving" | "error";
}) {
  return (
    <section className="backup-notice" aria-labelledby="backup-title">
      <div>
        <p className="eyebrow">قبل أن تبدأ</p>
        <h2 id="backup-title">لا يوجد نسخ احتياطي تلقائي</h2>
        <p>
          التصدير ينقل نسخة مشروع، لكنه ليس نظام نسخ احتياطي. فعّل FileVault
          ونسخ الجهاز الدوري.
        </p>
      </div>
      <div className="notice-actions">
        <button
          className="button button--accent"
          onClick={onAcknowledge}
          disabled={state === "saving"}
        >
          {state === "saving" ? "جارٍ الحفظ…" : "فهمت"}
        </button>
        <span className="notice-error" role="status" aria-live="polite">
          {state === "error"
            ? "تعذّر حفظ التأكيد. راجع حالة النظام ثم حاول مرة أخرى."
            : ""}
        </span>
      </div>
    </section>
  );
}

function LoadingView() {
  return (
    <main className="center-state" aria-busy="true">
      <div className="loading-mark">ح</div>
      <h1>نجهّز مساحة العمل المحلية</h1>
      <div className="skeleton-line" />
      <div className="skeleton-line skeleton-line--short" />
    </main>
  );
}

function FailureView({ stale }: { stale: boolean }) {
  const title = stale ? "انتهت جلسة التبويب المحلية" : "تعذّر فتح حكايتي";
  const message = stale
    ? "أُعيد تشغيل التطبيق وتغيّر رمز الطلب الآمن. أعد تحميل هذا العنوان المحلي."
    : "تأكد أن التطبيق يعمل، ثم افتح العنوان الذي عرضه المشغّل.";
  return (
    <main className="center-state center-state--error">
      <div className="error-mark" aria-hidden="true">
        !
      </div>
      <h1>{title}</h1>
      <p>{message}</p>
      <button
        className="button button--primary"
        onClick={() => window.location.reload()}
      >
        إعادة التحميل
      </button>
    </main>
  );
}

function category(reason: unknown): ErrorCategory {
  return reason instanceof ApiError && reason.category === "stale_session"
    ? "stale"
    : "connect";
}
