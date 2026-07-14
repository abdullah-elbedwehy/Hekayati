import { scopeLabel } from "../components/jobs/format";
import type { JobState, QueueJobProjection, QueueProjection } from "../types";

export type QueueFilter = "all" | "active" | JobState;

export interface QueueGroup {
  key: string;
  label: string;
  jobs: QueueJobProjection[];
  actions: QueueProjection["projectActions"][number] | undefined;
}

export function groupJobs(
  jobs: QueueJobProjection[],
  actions: QueueProjection["projectActions"],
): QueueGroup[] {
  const groups = new Map<string, QueueJobProjection[]>();
  for (const job of jobs) {
    const key = job.projectId ?? `standalone:${job.standaloneScopeId}`;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  return [...groups].map(([key, items]) => ({
    key,
    label: scopeLabel(items[0]),
    jobs: items,
    actions: actions.find((item) => item.projectId === items[0]?.projectId),
  }));
}

export function filterJobs(
  jobs: QueueJobProjection[],
  filter: QueueFilter,
): QueueJobProjection[] {
  if (filter === "all") return jobs;
  if (filter === "active")
    return jobs.filter(
      (job) => !["succeeded", "failed", "canceled"].includes(job.state),
    );
  return jobs.filter((job) => job.state === filter);
}

export function activeDepth(projection: QueueProjection): number {
  const activeStates: JobState[] = [
    "blocked",
    "queued",
    "claimed",
    "running",
    "paused",
    "waiting_review",
  ];
  return activeStates.reduce(
    (total, state) => total + projection.counts[state],
    0,
  );
}

export function workerLabel(
  status: QueueProjection["storage"]["workerStatus"],
): string {
  return { running: "يعمل", stopped: "متوقف", halted: "متوقف بسبب خطأ" }[
    status
  ];
}

export function storageReason(
  reason: QueueProjection["storage"]["reason"],
): string {
  return reason === "insufficient_disk_space"
    ? "المساحة الحرة غير كافية. لا يبدأ أي عمل جديد."
    : "تعذّرت كتابة ملف محلي. لا يبدأ أي عمل جديد.";
}

export const jobStates: JobState[] = [
  "queued",
  "running",
  "blocked",
  "paused",
  "waiting_review",
  "succeeded",
  "failed",
  "canceled",
];
