import { useMemo, useState } from "react";

import type { ApiClient } from "../api";
import { JobRow } from "../components/jobs/JobRow";
import { jobStateLabel } from "../components/jobs/JobStateBadge";
import {
  type QuotaDecision,
  QuotaDecisionDialog,
} from "../components/jobs/QuotaDecisionDialog";
import {
  formatQueueDate,
  formatQueueNumber,
  operationLabel,
  providerLabel,
} from "../components/jobs/format";
import {
  createQueueActions,
  type DirectAction,
  type QueueActions,
  type QueueData,
  useQueueData,
} from "../queue/queue-data";
import {
  activeDepth,
  filterJobs,
  groupJobs,
  jobStates,
  type QueueFilter,
  storageReason,
  workerLabel,
} from "../queue/queue-model";
import type {
  CredentialIncident,
  QueueJobProjection,
  QueueProjection,
  QuotaIncident,
} from "../types";

export function QueueView({
  client,
  onOpenProjects,
  onOpenSettings,
}: {
  client: ApiClient;
  onOpenProjects: () => void;
  onOpenSettings: () => void;
}) {
  const queue = useQueueData(client);
  const [filter, setFilter] = useState<QueueFilter>("active");
  const [incident, setIncident] = useState<QuotaIncident | null>(null);
  const groups = useMemo(
    () =>
      groupJobs(
        filterJobs(queue.projection?.jobs ?? [], filter),
        queue.projection?.projectActions ?? [],
      ),
    [filter, queue.projection?.jobs, queue.projection?.projectActions],
  );
  if (!queue.projection && !queue.error) return <QueueLoading />;
  if (!queue.projection) return <QueueLoadFailure retry={queue.refresh} />;
  return (
    <QueueScreen
      projection={queue.projection}
      queue={queue}
      groups={groups}
      filter={filter}
      setFilter={setFilter}
      incident={incident}
      setIncident={setIncident}
      onOpenProjects={onOpenProjects}
      onOpenSettings={onOpenSettings}
      actions={createQueueActions(client, queue)}
    />
  );
}

interface QueueScreenProps {
  projection: QueueProjection;
  queue: QueueData;
  groups: ReturnType<typeof groupJobs>;
  filter: QueueFilter;
  setFilter: (filter: QueueFilter) => void;
  incident: QuotaIncident | null;
  setIncident: (incident: QuotaIncident | null) => void;
  onOpenProjects: () => void;
  onOpenSettings: () => void;
  actions: QueueActions;
}

function QueueScreen({
  projection,
  queue,
  groups,
  filter,
  setFilter,
  incident,
  setIncident,
  onOpenProjects,
  onOpenSettings,
  actions,
}: QueueScreenProps) {
  return (
    <main className="view queue-view" id="main-content">
      <QueueHeader
        projection={projection}
        busy={queue.busy}
        refresh={queue.refresh}
      />
      <QueueOverview projection={projection} />
      <IncidentArea
        projection={projection}
        busy={queue.busy}
        onQuotaDecision={setIncident}
        onQuotaResume={actions.quotaResume}
        onCredentialResume={actions.credentialResume}
        onStorageResume={() => actions.storageResume(projection.storage)}
        onOpenSettings={onOpenSettings}
      />
      <QueueToolbar filter={filter} setFilter={setFilter} />
      <QueueFeedback error={queue.error} message={queue.actionMessage} />
      <QueueGroups
        groups={groups}
        busyKey={queue.busyKey}
        onOpenProjects={onOpenProjects}
        onAction={actions.job}
        onPriority={actions.priority}
        onProjectAction={actions.project}
      />
      <QueueQuotaDialog
        incident={incident}
        busy={queue.busy}
        setIncident={setIncident}
        decide={actions.quota}
      />
    </main>
  );
}

function QueueQuotaDialog({
  incident,
  busy,
  setIncident,
  decide,
}: {
  incident: QuotaIncident | null;
  busy: boolean;
  setIncident: (incident: QuotaIncident | null) => void;
  decide: QueueActions["quota"];
}) {
  const onDecision = (decision: QuotaDecision) => {
    if (incident)
      void decide(incident, decision).then((ok) => ok && setIncident(null));
  };
  return (
    <QuotaDecisionDialog
      incident={incident}
      busy={busy}
      onClose={() => setIncident(null)}
      onDecision={onDecision}
    />
  );
}

function QueueFeedback({
  error,
  message,
}: {
  error: boolean;
  message: string;
}) {
  return (
    <>
      {error && (
        <p className="queue-passive-error">
          تعذّر آخر تحديث تلقائي. البيانات المعروضة محفوظة.
        </p>
      )}
      <p className="queue-action-status" role="status" aria-live="polite">
        {message}
      </p>
    </>
  );
}

function QueueHeader({
  projection,
  busy,
  refresh,
}: {
  projection: QueueProjection;
  busy: boolean;
  refresh: () => Promise<void>;
}) {
  return (
    <header className="view-header view-header--with-action queue-header">
      <div>
        <p className="eyebrow">تنفيذ متين وواضح</p>
        <h1>قائمة المهام</h1>
        <p>كل انتظار له سبب. لا يتغير مزوّد أو نموذج أو محتوى معتمد بصمت.</p>
        <time dateTime={projection.checkedAt}>
          آخر قراءة: {formatQueueDate(projection.checkedAt)}
        </time>
      </div>
      <button
        className="button button--secondary"
        disabled={busy}
        onClick={() => void refresh()}
      >
        تحديث القائمة
      </button>
    </header>
  );
}

function QueueOverview({ projection }: { projection: QueueProjection }) {
  const active = activeDepth(projection);
  return (
    <section className="queue-overview" aria-labelledby="queue-overview-title">
      <div className="queue-overview__lead">
        <p className="eyebrow">الآن</p>
        <h2 id="queue-overview-title">
          {formatQueueNumber(active)} مهمة تحتاج متابعة
        </h2>
        <p>العامل: {workerLabel(projection.storage.workerStatus)}</p>
      </div>
      <dl>
        <OverviewFact label="في الانتظار" value={projection.counts.queued} />
        <OverviewFact
          label="قيد التنفيذ"
          value={projection.counts.running + projection.counts.claimed}
        />
        <OverviewFact
          label="متوقفة"
          value={projection.counts.paused + projection.counts.blocked}
        />
        <OverviewFact
          label="تنتظر المراجعة"
          value={projection.counts.waiting_review}
        />
        <OverviewFact label="بلا تقدّم" value={projection.stalledCount} />
      </dl>
    </section>
  );
}

function OverviewFact({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{formatQueueNumber(value)}</dd>
    </div>
  );
}

interface IncidentAreaProps {
  projection: QueueProjection;
  busy: boolean;
  onQuotaDecision: (incident: QuotaIncident) => void;
  onQuotaResume: (incident: QuotaIncident) => void;
  onCredentialResume: (incident: CredentialIncident) => void;
  onStorageResume: () => void;
  onOpenSettings: () => void;
}

function IncidentArea({
  projection,
  busy,
  onQuotaDecision,
  onQuotaResume,
  onCredentialResume,
  onStorageResume,
  onOpenSettings,
}: IncidentAreaProps) {
  const quota = projection.quotaIncidents.filter(
    (item) => item.status === "open",
  );
  const credentials = projection.credentialIncidents.filter(
    (item) => item.status === "open",
  );
  if (
    !projection.storage.active &&
    quota.length === 0 &&
    credentials.length === 0
  )
    return null;
  return (
    <section
      className="queue-incidents"
      aria-labelledby="queue-incidents-title"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">تحتاج قرارًا صريحًا</p>
          <h2 id="queue-incidents-title">حالات توقف عامة</h2>
        </div>
      </div>
      <IncidentRows
        projection={projection}
        quota={quota}
        credentials={credentials}
        busy={busy}
        onQuotaDecision={onQuotaDecision}
        onQuotaResume={onQuotaResume}
        onCredentialResume={onCredentialResume}
        onStorageResume={onStorageResume}
        onOpenSettings={onOpenSettings}
      />
    </section>
  );
}

function IncidentRows({
  projection,
  quota,
  credentials,
  busy,
  onQuotaDecision,
  onQuotaResume,
  onCredentialResume,
  onStorageResume,
  onOpenSettings,
}: IncidentAreaProps & {
  quota: QuotaIncident[];
  credentials: CredentialIncident[];
}) {
  return (
    <>
      {projection.storage.active && (
        <StorageIncident
          projection={projection}
          busy={busy}
          onResume={onStorageResume}
        />
      )}
      {quota.map((incident) => (
        <QuotaIncidentRow
          key={incident.id}
          incident={incident}
          busy={busy}
          onDecision={onQuotaDecision}
          onResume={onQuotaResume}
        />
      ))}
      {credentials.map((incident) => (
        <CredentialIncidentRow
          key={incident.id}
          incident={incident}
          busy={busy}
          onOpenSettings={onOpenSettings}
          onResume={onCredentialResume}
        />
      ))}
    </>
  );
}

function CredentialIncidentRow({
  incident,
  busy,
  onOpenSettings,
  onResume,
}: {
  incident: CredentialIncident;
  busy: boolean;
  onOpenSettings: () => void;
  onResume: (incident: CredentialIncident) => void;
}) {
  return (
    <div className="queue-incident queue-incident--danger">
      <div>
        <strong>
          بيانات اتصال {providerLabel(incident.providerId)} غير صالحة
        </strong>
        <p>
          توقفت {formatQueueNumber(incident.affectedCount)} مهمة مرتبطة بهذا
          المزوّد. أصلح الإعدادات أولًا، ثم شغّل الفحص الصريح.
        </p>
      </div>
      <div className="queue-incident__actions">
        <button className="button button--secondary" onClick={onOpenSettings}>
          فتح إعدادات المزوّد
        </button>
        <button
          className="button button--danger"
          disabled={busy || !incident.impactHash}
          onClick={() => onResume(incident)}
        >
          تحقق ثم استأنف
        </button>
      </div>
    </div>
  );
}

function StorageIncident({
  projection,
  busy,
  onResume,
}: {
  projection: QueueProjection;
  busy: boolean;
  onResume: () => void;
}) {
  return (
    <div className="queue-incident queue-incident--danger">
      <div>
        <strong>توقف التنفيذ لحماية التخزين المحلي</strong>
        <p>{storageReason(projection.storage.reason)}</p>
        {projection.storage.resumeImpact && (
          <p>
            التأكيد سيجري فحصًا محليًا ثم يستأنف فقط{" "}
            {formatQueueNumber(projection.storage.resumeImpact.affectedCount)}{" "}
            مهمة أوقفها هذا العطل.
          </p>
        )}
      </div>
      <button
        className="button button--danger"
        disabled={busy || !projection.storage.resumeImpact}
        onClick={onResume}
      >
        افحص التخزين ثم استأنف
      </button>
    </div>
  );
}

function QuotaIncidentRow({
  incident,
  busy,
  onDecision,
  onResume,
}: {
  incident: QuotaIncident;
  busy: boolean;
  onDecision: (incident: QuotaIncident) => void;
  onResume: (incident: QuotaIncident) => void;
}) {
  return (
    <div className="queue-incident">
      <div>
        <strong>حصة {providerLabel(incident.providerId)} متوقفة</strong>
        <p>
          {operationLabel(incident.operation)}،{" "}
          {formatQueueNumber(incident.affectedScopeIds.length)} نطاق عمل متأثر.
        </p>
      </div>
      <div className="queue-incident__actions">
        <button
          className="button button--primary"
          disabled={busy || incident.scopes.length === 0}
          onClick={() => onDecision(incident)}
        >
          اختر قرار كل نطاق
        </button>
        <button
          className="button button--secondary"
          disabled={busy || !incident.resumeImpact}
          onClick={() => onResume(incident)}
        >
          تحقق من عودة المزوّد
          {incident.resumeImpact
            ? ` واستأنف ${formatQueueNumber(incident.resumeImpact.affectedCount)} مهمة`
            : ""}
        </button>
      </div>
    </div>
  );
}

function QueueToolbar({
  filter,
  setFilter,
}: {
  filter: QueueFilter;
  setFilter: (value: QueueFilter) => void;
}) {
  return (
    <section className="queue-toolbar" aria-label="تصفية قائمة المهام">
      <label className="field">
        <span>اعرض</span>
        <select
          value={filter}
          onChange={(event) => setFilter(event.target.value as QueueFilter)}
        >
          <option value="active">المهام التي تحتاج متابعة</option>
          <option value="all">كل المهام</option>
          {jobStates.map((state) => (
            <option key={state} value={state}>
              {jobStateLabel(state)}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

function QueueGroups({
  groups,
  busyKey,
  onAction,
  onPriority,
  onProjectAction,
  onOpenProjects,
}: {
  groups: ReturnType<typeof groupJobs>;
  busyKey: string | null;
  onAction: (job: QueueJobProjection, action: DirectAction) => void;
  onPriority: (job: QueueJobProjection, priority: number) => void;
  onProjectAction: QueueActions["project"];
  onOpenProjects: () => void;
}) {
  if (groups.length === 0) return <QueueEmpty />;
  return (
    <div className="queue-groups">
      {groups.map((group) => (
        <QueueGroupItem
          key={group.key}
          group={group}
          busyKey={busyKey}
          onAction={onAction}
          onPriority={onPriority}
          onProjectAction={onProjectAction}
          onOpenProjects={onOpenProjects}
        />
      ))}
    </div>
  );
}

function QueueGroupItem({
  group,
  busyKey,
  onAction,
  onPriority,
  onProjectAction,
  onOpenProjects,
}: {
  group: ReturnType<typeof groupJobs>[number];
  busyKey: string | null;
  onAction: (job: QueueJobProjection, action: DirectAction) => void;
  onPriority: (job: QueueJobProjection, priority: number) => void;
  onProjectAction: QueueActions["project"];
  onOpenProjects: () => void;
}) {
  const projectId = group.jobs[0]?.projectId ?? null;
  return (
    <section className="queue-group" aria-labelledby={`scope-${group.key}`}>
      <div className="queue-group__heading">
        <div>
          <p className="eyebrow">نطاق عمل</p>
          <h2 id={`scope-${group.key}`}>{group.label}</h2>
        </div>
        {projectId && group.actions && (
          <ProjectControls
            projectId={projectId}
            actions={group.actions}
            busy={busyKey === `project:${projectId}`}
            onAction={onProjectAction}
          />
        )}
      </div>
      <div className="queue-jobs">
        {group.jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            busy={busyKey === job.id}
            onAction={onAction}
            onPriority={onPriority}
            onOpenProjects={onOpenProjects}
          />
        ))}
      </div>
    </section>
  );
}

function ProjectControls({
  projectId,
  actions,
  busy,
  onAction,
}: {
  projectId: string;
  actions: QueueProjection["projectActions"][number];
  busy: boolean;
  onAction: QueueActions["project"];
}) {
  const canPause = actions.pause.affectedCount > 0;
  const canResume = actions.resume.affectedCount > 0;
  if (!canPause && !canResume) return null;
  return (
    <div className="project-job-controls">
      <span>المهام الجارية قد تكمل وتحفظ عملها.</span>
      {canPause && (
        <button
          className="button button--secondary"
          disabled={busy}
          onClick={() => onAction(projectId, "pause", actions.pause.impactHash)}
        >
          إيقاف {formatQueueNumber(actions.pause.affectedCount)} مهمة مؤقتًا
        </button>
      )}
      {canResume && (
        <button
          className="button button--secondary"
          disabled={busy}
          onClick={() =>
            onAction(projectId, "resume", actions.resume.impactHash)
          }
        >
          استئناف {formatQueueNumber(actions.resume.affectedCount)} مهمة
        </button>
      )}
    </div>
  );
}

function QueueLoading() {
  return (
    <main className="view queue-view" id="main-content" aria-busy="true">
      <header className="view-header">
        <p className="eyebrow">قائمة المهام</p>
        <h1>نقرأ الحالة المحفوظة</h1>
      </header>
      <div className="queue-loading-lines">
        <span />
        <span />
        <span />
      </div>
    </main>
  );
}

function QueueLoadFailure({ retry }: { retry: () => Promise<void> }) {
  return (
    <main className="view queue-view" id="main-content">
      <header className="view-header">
        <p className="eyebrow">قائمة المهام</p>
        <h1>تعذّرت قراءة القائمة</h1>
        <p>
          لم يبدأ التطبيق أي فحص للمزوّد. حاول قراءة الحالة المحلية مرة أخرى.
        </p>
      </header>
      <button className="button button--primary" onClick={() => void retry()}>
        إعادة القراءة
      </button>
    </main>
  );
}

function QueueEmpty() {
  return (
    <section className="queue-empty">
      <span className="queue-empty__mark" aria-hidden="true">
        ح
      </span>
      <div>
        <h2>لا توجد مهام ضمن هذا العرض</h2>
        <p>
          غيّر المرشح لرؤية السجل الكامل. إضافة العمل تبدأ من المشروع المالك.
        </p>
      </div>
    </section>
  );
}
