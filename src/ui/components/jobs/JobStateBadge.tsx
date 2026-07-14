import type { JobState } from "../../types";

const stateLabels: Record<JobState, string> = {
  created: "تم إنشاؤها",
  blocked: "متوقفة على اعتماد",
  queued: "في الانتظار",
  claimed: "حُجزت للتنفيذ",
  running: "قيد التنفيذ",
  succeeded: "اكتملت",
  failed: "فشلت",
  paused: "متوقفة",
  canceled: "أُلغيت",
  waiting_review: "تنتظر المراجعة",
};

const reasonLabels: Record<string, string> = {
  dependency: "تنتظر مهمة سابقة",
  operator: "أوقفها المشغّل",
  quota: "حصة المزوّد غير متاحة",
  storage: "التخزين المحلي متوقف",
  credentials: "بيانات اتصال المزوّد تحتاج مراجعة",
  retry_delay: "تنتظر موعد إعادة المحاولة",
  retry_exhausted: "اكتملت محاولات الإعادة التلقائية",
  recovered: "استعيدت بعد إعادة التشغيل",
  shutdown: "أعيدت للقائمة عند إغلاق التطبيق",
  user_canceled: "ألغيت بطلب المشغّل",
  superseded: "استُبدلت بمهمة مرتبطة",
  stale_dependency: "تغيّر أحد المدخلات",
  safety_refusal: "رفض المزوّد المحتوى وفق ضوابط السلامة",
  invalid_input: "المدخلات غير صالحة",
  provider_unavailable: "المزوّد أو النموذج غير متاح",
  invalid_credentials: "بيانات اتصال المزوّد غير صالحة",
  rate_limited: "المزوّد يحدّ الطلبات مؤقتًا",
  malformed_output: "استجابة المزوّد غير قابلة للقراءة",
  output_validation_failed: "استجابة المزوّد لا تطابق العقد",
  media_decode_failure: "تعذّر التحقق من ملف الصورة",
  PHOTO_CONSENT_NOT_RECORDED: "لم يُسجّل قرار موافقة الصور",
  PHOTO_CONSENT_NOT_GRANTED: "استخدام الصور غير مصرح به",
  JOB_REFERENCE_ASSET_MISSING: "ملف مرجع مطلوب غير موجود",
  JOB_REFERENCE_CHECKSUM_MISMATCH: "تغيّر ملف مرجع منذ بدء المهمة",
  JOB_REFERENCE_SNAPSHOT_MISMATCH: "تغيّرت مراجع المهمة",
  JOB_SHEET_LINEAGE_READER_MISSING: "تعذّر التحقق من أصل لوحة الشخصية",
  SHEET_NOT_FOUND: "لوحة الشخصية المطلوبة غير موجودة",
  SHEET_NOT_APPROVED: "لوحة الشخصية لم تُعتمد",
  SHEET_REFERENCE_MISMATCH: "مرجع لوحة الشخصية لا يطابق المهمة",
  SHEET_LINEAGE_INVALID: "أصل لوحة الشخصية غير صالح",
};

export function JobStateBadge({
  state,
  reason,
}: {
  state: JobState;
  reason: string | null;
}) {
  return (
    <span className={`job-state job-state--${state}`}>
      <span className="job-state__mark" aria-hidden="true" />
      <span>{jobStateLabel(state)}</span>
      {reason && (
        <span className="job-state__reason">، {jobReasonLabel(reason)}</span>
      )}
    </span>
  );
}

export function jobStateLabel(state: JobState): string {
  return stateLabels[state];
}

export function jobReasonLabel(reason: string): string {
  return reasonLabels[reason] ?? "سبب تقني مسجّل يحتاج مراجعة";
}

export function failureCategoryLabel(category: string): string {
  return (
    {
      invalid_input: "مدخلات غير صالحة",
      missing_reference_asset: "مرجع مطلوب غير متاح",
      provider_unavailable: "المزوّد غير متاح",
      invalid_credentials: "بيانات اتصال غير صالحة",
      quota_exhausted: "نفاد حصة المزوّد",
      rate_limited: "تحديد مؤقت للطلبات",
      timeout: "انتهاء المهلة",
      network_failure: "تعذّر الاتصال",
      safety_refusal: "رفض سلامة",
      malformed_output: "استجابة غير قابلة للقراءة",
      output_validation_failed: "استجابة لا تطابق العقد",
      media_decode_failure: "ملف صورة غير صالح",
      disk_write_failure: "تعذّرت الكتابة المحلية",
      insufficient_disk_space: "مساحة غير كافية",
      database_unavailable: "قاعدة البيانات غير متاحة",
      user_canceled: "إلغاء المشغّل",
      stale_dependency: "مدخلات قديمة",
      unknown: "تعذّر غير مصنّف",
    }[category] ?? "تعذّر مسجّل"
  );
}
