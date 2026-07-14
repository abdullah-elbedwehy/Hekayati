import { z } from "zod";

export const failureCategorySchema = z.enum([
  "invalid_input",
  "missing_reference_asset",
  "provider_unavailable",
  "invalid_credentials",
  "quota_exhausted",
  "rate_limited",
  "timeout",
  "network_failure",
  "safety_refusal",
  "malformed_output",
  "output_validation_failed",
  "media_decode_failure",
  "disk_write_failure",
  "insufficient_disk_space",
  "database_unavailable",
  "user_canceled",
  "stale_dependency",
  "unknown",
]);

export type FailureCategory = z.infer<typeof failureCategorySchema>;

export const normalizedFailureSchema = z
  .object({
    category: failureCategorySchema,
    message: z.string().trim().min(1).max(240),
    retryable: z.boolean(),
    providerDetail: z.string().trim().min(1).max(1_500).optional(),
    retryAfterMs: z.number().int().positive().max(86_400_000).optional(),
  })
  .strict();

export type NormalizedFailure = z.infer<typeof normalizedFailureSchema>;

const retryableCategories = new Set<FailureCategory>([
  "provider_unavailable",
  "rate_limited",
  "timeout",
  "network_failure",
  "malformed_output",
  "output_validation_failed",
  "media_decode_failure",
]);

const safeMessages: Record<FailureCategory, string> = {
  invalid_input: "المدخلات غير صالحة لهذه العملية.",
  missing_reference_asset: "إحدى صور المرجع المطلوبة غير متاحة.",
  provider_unavailable: "المزوّد أو النموذج المطلوب غير متاح.",
  invalid_credentials: "بيانات اتصال المزوّد غير موجودة أو غير صالحة.",
  quota_exhausted: "نفدت حصة المزوّد المتاحة.",
  rate_limited: "المزوّد يحدّ الطلبات مؤقتًا.",
  timeout: "انتهت مهلة طلب المزوّد.",
  network_failure: "تعذّر الاتصال بالمزوّد.",
  safety_refusal: "رفض المزوّد المحتوى وفق ضوابط السلامة.",
  malformed_output: "أعاد المزوّد استجابة غير قابلة للقراءة.",
  output_validation_failed: "استجابة المزوّد لا تطابق العقد المطلوب.",
  media_decode_failure: "تعذّر التحقق من ملف الصورة.",
  disk_write_failure: "تعذّرت كتابة الملف محليًا.",
  insufficient_disk_space: "المساحة المحلية غير كافية.",
  database_unavailable: "قاعدة البيانات المحلية غير متاحة.",
  user_canceled: "ألغى المشغّل العملية.",
  stale_dependency: "تغيّر أحد المدخلات منذ بدء العملية.",
  unknown: "تعذّرت العملية بسبب خطأ غير مصنّف.",
};

export function makeFailure(
  category: FailureCategory,
  options: {
    providerDetail?: string;
    retryAfterMs?: number;
    message?: string;
  } = {},
): NormalizedFailure {
  return normalizedFailureSchema.parse({
    category,
    message: options.message ?? safeMessages[category],
    retryable: retryableCategories.has(category),
    providerDetail: options.providerDetail,
    retryAfterMs: options.retryAfterMs,
  });
}

export function failureResult(category: FailureCategory) {
  return { ok: false as const, failure: makeFailure(category) };
}
