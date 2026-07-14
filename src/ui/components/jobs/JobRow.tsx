import type { QueueAction, QueueJobProjection } from "../../types";
import { JobDetails } from "./JobDetails";
import { JobStateBadge } from "./JobStateBadge";
import { formatQueueDate, formatQueueNumber, priorityLabel } from "./format";
import { QueueControls } from "./QueueControls";

type DirectAction = Exclude<QueueAction, "priority" | "open_gate">;

export function JobRow({
  job,
  busy,
  onAction,
  onPriority,
  onOpenProjects,
}: {
  job: QueueJobProjection;
  busy: boolean;
  onAction: (job: QueueJobProjection, action: DirectAction) => void;
  onPriority: (job: QueueJobProjection, priority: number) => void;
  onOpenProjects: () => void;
}) {
  return (
    <article className="job-card" data-state={job.state}>
      <JobSummary job={job} />
      {job.progress && (
        <div className="job-card__progress">
          <span>التقدّم</span>
          <progress max="100" value={job.progress.percent} />
          <strong>{formatQueueNumber(job.progress.percent)}٪</strong>
        </div>
      )}
      <details className="job-card__details">
        <summary>عرض الاعتمادات والوجهة والسجل</summary>
        <JobDetails job={job} onOpenProjects={onOpenProjects} />
      </details>
      <QueueControls
        job={job}
        busy={busy}
        onAction={(action) => onAction(job, action)}
        onPriority={(priority) => onPriority(job, priority)}
      />
    </article>
  );
}

function JobSummary({ job }: { job: QueueJobProjection }) {
  const position =
    job.queuePosition === null
      ? "غير متاح"
      : formatQueueNumber(job.queuePosition);
  return (
    <div className="job-card__main">
      <div className="job-card__identity">
        <p className="job-card__type">
          <bdi dir="ltr">{job.jobType}</bdi>
        </p>
        <h3>
          مهمة <bdi dir="ltr">{job.id}</bdi>
        </h3>
        <JobStateBadge state={job.state} reason={job.stateReason} />
      </div>
      <dl className="job-card__summary">
        <SummaryFact label="الموضع" value={position} />
        <SummaryFact label="الأولوية" value={priorityLabel(job.priority)} />
        <SummaryFact
          label="المحاولات"
          value={formatQueueNumber(job.attempts)}
        />
        <SummaryFact label="آخر تحديث" value={formatQueueDate(job.updatedAt)} />
      </dl>
    </div>
  );
}

function SummaryFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
