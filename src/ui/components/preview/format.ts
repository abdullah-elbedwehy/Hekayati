import type {
  LayoutApprovalCycle,
  LayoutPageProjection,
  LayoutProjectProjection,
} from "../../layout-types";

export const placementOptions = [
  { value: "auto", label: "تلقائي" },
  { value: "top", label: "أعلى" },
  { value: "bottom", label: "أسفل" },
  { value: "right", label: "يمين" },
  { value: "left", label: "يسار" },
] as const;

export function workflowLabel(
  state: NonNullable<LayoutProjectProjection["workflow"]>["state"] | null,
) {
  const labels: Record<string, { icon: string; text: string }> = {
    layout_pending: { icon: "…", text: "تنسيق الصفحات" },
    operator_action_required: { icon: "!", text: "يحتاج إجراء" },
    pdf_pending: { icon: "…", text: "في قائمة PDF" },
    rendering: { icon: "…", text: "جارٍ الرسم" },
    validating: { icon: "…", text: "فحص ميكانيكي" },
    ready: { icon: "✓", text: "جاهز" },
    failed: { icon: "×", text: "فشل" },
  };
  return state
    ? (labels[state] ?? { icon: "!", text: state })
    : { icon: "—", text: "لم يبدأ" };
}

export function approvalLabel(state: LayoutApprovalCycle["state"] | null) {
  const labels: Record<string, { icon: string; text: string }> = {
    ready_to_send: { icon: "…", text: "جاهزة للإرسال" },
    preview_sent: { icon: "↗", text: "أُرسلت" },
    approved: { icon: "✓", text: "معتمدة" },
    changes_requested: { icon: "!", text: "تعديلات مطلوبة" },
    invalidated: { icon: "×", text: "ملغاة" },
  };
  return state
    ? (labels[state] ?? { icon: "!", text: state })
    : { icon: "—", text: "لا دورة" };
}

export function pageKindLabel(kind: LayoutPageProjection["kind"]): string {
  return {
    title: "العنوان",
    dedication: "الإهداء",
    story: "حكاية",
    ending1: "الوداع",
    ending2: "هوية حكايتي",
  }[kind];
}

export function placementLabel(value?: string): string {
  return placementOptions.find((item) => item.value === value)?.label ?? "—";
}

export function aidLabel(value?: string): string {
  if (value === "gradient") return "تدرّج";
  if (value === "panel") return "لوحة";
  if (value === "none") return "بلا مساعدة";
  return "—";
}

export function shortId(value?: string | null): string {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—";
}

export function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
