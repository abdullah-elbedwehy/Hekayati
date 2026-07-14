import type { QueueAction, QueueJobProjection } from "../../types";
import { priorityLabel } from "./format";

type DirectAction = Exclude<QueueAction, "priority" | "open_gate">;

export function QueueControls({
  job,
  busy,
  onAction,
  onPriority,
}: {
  job: QueueJobProjection;
  busy: boolean;
  onAction: (action: DirectAction) => void;
  onPriority: (priority: number) => void;
}) {
  const actions = job.allowedActions;
  if (actions.length === 0 || actions[0] === "open_gate") return null;
  return (
    <div className="job-controls" aria-label="إجراءات المهمة">
      <p className="job-controls__note">{consequenceText(actions)}</p>
      <div className="job-controls__buttons">
        <DirectButtons actions={actions} busy={busy} onAction={onAction} />
        {actions.includes("priority") && (
          <PriorityControl job={job} busy={busy} onPriority={onPriority} />
        )}
      </div>
    </div>
  );
}

function DirectButtons({
  actions,
  busy,
  onAction,
}: {
  actions: QueueAction[];
  busy: boolean;
  onAction: (action: DirectAction) => void;
}) {
  return (
    <>
      {actions.includes("pause") && (
        <ActionButton
          label="إيقاف مؤقت"
          busy={busy}
          onClick={() => onAction("pause")}
        />
      )}
      {actions.includes("resume") && (
        <ActionButton
          label="استئناف"
          busy={busy}
          onClick={() => onAction("resume")}
        />
      )}
      {actions.includes("retry") && (
        <ActionButton
          label="إعادة المحاولة"
          busy={busy}
          onClick={() => confirmRetry() && onAction("retry")}
        />
      )}
      {actions.includes("cancel") && (
        <button
          className="button button--danger"
          disabled={busy}
          onClick={() => confirmCancel() && onAction("cancel")}
        >
          إلغاء المهمة
        </button>
      )}
    </>
  );
}

function PriorityControl({
  job,
  busy,
  onPriority,
}: {
  job: QueueJobProjection;
  busy: boolean;
  onPriority: (priority: number) => void;
}) {
  return (
    <label className="job-priority">
      <span>الأولوية</span>
      <select
        value={job.priority}
        disabled={busy}
        onChange={(event) => changePriority(event.target.value, onPriority)}
      >
        {[1, 2, 3, 4, 5].map((priority) => (
          <option key={priority} value={priority}>
            {priorityLabel(priority)}
          </option>
        ))}
      </select>
    </label>
  );
}

function changePriority(value: string, onPriority: (priority: number) => void) {
  const next = Number(value);
  if (confirmPriority(priorityLabel(next))) onPriority(next);
}

function ActionButton({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="button button--secondary"
      disabled={busy}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function consequenceText(actions: QueueAction[]): string {
  if (actions.includes("retry"))
    return "إعادة المحاولة تحفظ الطلب والوجهة نفسيهما وتبدأ دورة موثّقة جديدة.";
  if (actions.includes("cancel"))
    return "الإلغاء يسبق إيقاف التنفيذ؛ أي نتيجة متأخرة لن تُحفظ.";
  return "الإيقاف والاستئناف يغيّران العمل غير المنفّذ فقط.";
}

function confirmCancel(): boolean {
  return window.confirm(
    "إلغاء هذه المهمة نهائي. ستُرفض أي نتيجة تصل بعد الإلغاء. هل تريد المتابعة؟",
  );
}

function confirmRetry(): boolean {
  return window.confirm(
    "ستُعاد المحاولة بالطلب والمزوّد والنموذج أنفسهم. هل تريد المتابعة؟",
  );
}

function confirmPriority(label: string): boolean {
  return window.confirm(
    `ستتغير أولوية العمل غير المحجوز إلى «${label}». هل تريد المتابعة؟`,
  );
}
