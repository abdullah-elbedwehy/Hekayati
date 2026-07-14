import type { JobOperation, ProviderId, QueueJobProjection } from "../../types";

const numberFormat = new Intl.NumberFormat("ar-EG-u-nu-latn");
const dateFormat = new Intl.DateTimeFormat("ar-EG-u-nu-latn", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatQueueNumber(value: number): string {
  return numberFormat.format(value);
}

export function formatQueueDate(value: string): string {
  return dateFormat.format(new Date(value));
}

export function providerLabel(provider: ProviderId): string {
  return { mock: "المزوّد التجريبي", codex: "Codex", gemini: "Gemini" }[
    provider
  ];
}

export function operationLabel(operation: JobOperation): string {
  return {
    text: "نص",
    structured: "بيانات منظّمة",
    image: "صورة",
  }[operation];
}

export function scopeLabel(job: QueueJobProjection): string {
  if (job.projectId) return `مشروع ${shortId(job.projectId)}`;
  return `عمل مستقل ${shortId(job.standaloneScopeId ?? job.id)}`;
}

export function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}

export function priorityLabel(priority: number): string {
  return (
    {
      1: "منخفض جدًا",
      2: "منخفض",
      3: "عادي",
      4: "مرتفع",
      5: "عاجل",
    }[priority] ?? "عادي"
  );
}
