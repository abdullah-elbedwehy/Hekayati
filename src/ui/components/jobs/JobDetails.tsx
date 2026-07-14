import type { ReactNode } from "react";

import type { JobEvent, QueueJobProjection } from "../../types";
import {
  failureCategoryLabel,
  jobReasonLabel,
  jobStateLabel,
} from "./JobStateBadge";
import {
  formatQueueDate,
  formatQueueNumber,
  operationLabel,
  providerLabel,
} from "./format";

export function JobDetails({
  job,
  onOpenProjects,
}: {
  job: QueueJobProjection;
  onOpenProjects: () => void;
}) {
  return (
    <div className="job-details">
      <ProgressDetails job={job} />
      <DependencyDetails job={job} />
      <TargetDetails job={job} />
      <FailureDetails job={job} />
      <GateDetails job={job} onOpenProjects={onOpenProjects} />
      <ResultDetails job={job} onOpenProjects={onOpenProjects} />
      <HistoryDetails history={job.history} />
    </div>
  );
}

function ProgressDetails({ job }: { job: QueueJobProjection }) {
  return (
    <section aria-labelledby={`progress-${job.id}`}>
      <h4 id={`progress-${job.id}`}>التقدّم والمحاولات</h4>
      {job.progress ? (
        <div className="job-progress">
          <progress max="100" value={job.progress.percent}>
            {job.progress.percent}%
          </progress>
          <span>{formatQueueNumber(job.progress.percent)}٪</span>
          <bdi dir="ltr">{job.progress.noteCode}</bdi>
        </div>
      ) : (
        <p className="quiet-note">لا توجد نسبة تقدّم مسجّلة لهذه المحاولة.</p>
      )}
      {job.noProgress && (
        <p className="job-warning">لم يُسجَّل تقدّم منذ عشر دقائق على الأقل.</p>
      )}
      <dl className="job-facts">
        <Fact label="المحاولات" value={formatQueueNumber(job.attempts)} />
        <Fact
          label="الإعادة التلقائية"
          value={formatQueueNumber(job.automaticRetries)}
        />
        <Fact
          label="الإعادة اليدوية"
          value={formatQueueNumber(job.manualRetries)}
        />
      </dl>
    </section>
  );
}

function DependencyDetails({ job }: { job: QueueJobProjection }) {
  if (job.blockers.length === 0) return null;
  return (
    <section aria-labelledby={`dependencies-${job.id}`}>
      <h4 id={`dependencies-${job.id}`}>المهام التي تنتظرها</h4>
      <ul className="job-reference-list">
        {job.blockers.map((blocker) => (
          <li key={blocker.id}>
            <bdi dir="ltr">{blocker.id}</bdi>
            <span>
              {jobStateLabel(blocker.state)}
              {blocker.reason ? `، ${jobReasonLabel(blocker.reason)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TargetDetails({ job }: { job: QueueJobProjection }) {
  if (!job.target) return null;
  return (
    <section aria-labelledby={`target-${job.id}`}>
      <h4 id={`target-${job.id}`}>الوجهة الدقيقة</h4>
      <dl className="job-facts">
        <Fact label="المزوّد" value={providerLabel(job.target.providerId)} />
        <Fact label="العملية" value={operationLabel(job.target.operation)} />
        <Fact
          label="النموذج"
          value={<bdi dir="ltr">{job.target.modelId}</bdi>}
        />
      </dl>
    </section>
  );
}

function FailureDetails({ job }: { job: QueueJobProjection }) {
  if (!job.failure) return null;
  return (
    <section className="job-failure" aria-labelledby={`failure-${job.id}`}>
      <h4 id={`failure-${job.id}`}>آخر تعذّر آمن</h4>
      <p>{job.failure.message}</p>
      <p>التصنيف: {failureCategoryLabel(job.failure.category)}</p>
    </section>
  );
}

function GateDetails({
  job,
  onOpenProjects,
}: {
  job: QueueJobProjection;
  onOpenProjects: () => void;
}) {
  if (!job.gate) return null;
  return (
    <section aria-labelledby={`gate-${job.id}`}>
      <h4 id={`gate-${job.id}`}>مراجعة بشرية مطلوبة</h4>
      <p>
        افتح العنصر المالك وراجع النسخة المطلوبة. لا يمكن اعتمادها من قائمة
        المهام.
      </p>
      <dl className="job-facts">
        <Fact
          label="نوع المراجعة"
          value={<bdi dir="ltr">{job.gate.gateKind}</bdi>}
        />
        <Fact
          label="العنصر المالك"
          value={<bdi dir="ltr">{job.gate.targetId}</bdi>}
        />
        <Fact
          label="النسخة المطلوبة"
          value={<bdi dir="ltr">{job.gate.targetVersionId}</bdi>}
        />
      </dl>
      <a className="job-link" href="#projects" onClick={onOpenProjects}>
        فتح العنصر للمراجعة
        <bdi dir="ltr">{job.gate.targetVersionId}</bdi>
      </a>
    </section>
  );
}

function ResultDetails({
  job,
  onOpenProjects,
}: {
  job: QueueJobProjection;
  onOpenProjects: () => void;
}) {
  if (!job.provenance && job.resultRefs.length === 0) return null;
  return (
    <section aria-labelledby={`results-${job.id}`}>
      <h4 id={`results-${job.id}`}>النتيجة وسجل المنشأ</h4>
      {job.provenance && (
        <p>
          أُنتجت عبر {providerLabel(job.provenance.provider)} · نموذج{" "}
          <bdi dir="ltr">{job.provenance.modelId}</bdi> · المحاولة{" "}
          {formatQueueNumber(job.provenance.attempt)} ·{" "}
          {formatQueueDate(job.provenance.at)}
        </p>
      )}
      {job.resultRefs.map((reference) => (
        <a
          className="job-link"
          href="#projects"
          onClick={onOpenProjects}
          key={reference}
        >
          فتح النتيجة <bdi dir="ltr">{reference}</bdi>
        </a>
      ))}
    </section>
  );
}

function HistoryDetails({ history }: { history: JobEvent[] }) {
  if (history.length === 0) return null;
  return (
    <section aria-labelledby={`history-${history[0]?.jobId}`}>
      <h4 id={`history-${history[0]?.jobId}`}>السجل</h4>
      <ol className="job-history">
        {history.map((event) => (
          <li key={event.id}>
            <time dateTime={event.createdAt}>
              {formatQueueDate(event.createdAt)}
            </time>
            <span>{eventLabel(event)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function eventLabel(event: JobEvent): string {
  const labels: Record<string, string> = {
    enqueued: "أُضيفت إلى القائمة",
    claimed: "حجزها عامل التنفيذ",
    running: "بدأ التنفيذ",
    heartbeat: "تأكيد استمرار التنفيذ",
    progress: "سُجّل تقدّم",
    retry_scheduled: "حُدّدت إعادة محاولة",
    failed: "فشلت",
    paused: "توقفت",
    resumed: "استؤنفت",
    canceled: "أُلغيت",
    priority_changed: "تغيّرت الأولوية",
    succeeded: "اكتملت",
    commit_rejected: "رُفض حفظ نتيجة متأخرة",
    recovered: "استعيدت بعد تشغيل جديد",
    gate_completed: "اكتملت المراجعة عند مالكها",
    successor_linked: "رُبطت بمهمة بديلة",
  };
  const base = labels[event.kind] ?? "تحديث مسجّل";
  if (event.reason) return `${base}، ${jobReasonLabel(event.reason)}`;
  if (
    event.noteCode &&
    ["retry_scheduled", "failed", "paused", "canceled"].includes(event.kind)
  )
    return `${base}، ${failureCategoryLabel(event.noteCode)}`;
  return base;
}
