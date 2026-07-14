import { ApiError } from "../../api";
import type {
  CharacterProfile,
  PhotoWarningCode,
  RelationshipType,
  SourceMode,
} from "../../types";

export const relationshipOptions: Array<{
  value: RelationshipType;
  label: string;
}> = [
  { value: "main_child", label: "الطفل محور العائلة" },
  { value: "father", label: "الأب" },
  { value: "mother", label: "الأم" },
  { value: "brother", label: "الأخ" },
  { value: "sister", label: "الأخت" },
  { value: "grandfather", label: "الجد" },
  { value: "grandmother", label: "الجدة" },
  { value: "friend", label: "صديق أو صديقة" },
  { value: "teacher", label: "المعلّم أو المعلّمة" },
  { value: "pet", label: "حيوان أليف" },
  { value: "custom", label: "علاقة أخرى" },
];

export const sourceModeOptions: Array<{ value: SourceMode; label: string }> = [
  { value: "description", label: "وصف فقط" },
  { value: "photo", label: "صورة فقط" },
  { value: "both", label: "صورة ووصف" },
];

const warningLabels: Record<PhotoWarningCode, string> = {
  PHOTO_LIMITED_REFERENCES: "المراجع قليلة، أضف زوايا أخرى إن أمكن.",
  PHOTO_BLURRY: "الصورة غير حادة بما يكفي.",
  PHOTO_FACE_TOO_SMALL: "الشخص المقصود صغير داخل الإطار.",
  PHOTO_MULTIPLE_PEOPLE: "تظهر عدة أشخاص، حدّد الشخص المقصود بوضوح.",
  PHOTO_EXTREME_SHADOWS: "الإضاءة أو الظلال شديدة.",
  PHOTO_OBSTRUCTED: "توجد ملاحظة عن حجب ملامح الوجه.",
  PHOTO_FILTER_SUSPECTED: "قد تؤثر مرشحات الصورة في المرجع.",
  PHOTO_AGE_CONFLICT: "وصف الفئة العمرية يختلف بين المراجع.",
  PHOTO_HAIR_CONFLICT: "وصف الشعر يختلف بين المراجع.",
  PHOTO_CLOTHING_CONFLICT: "وصف الملابس يختلف بين المراجع.",
};

const errorLabels: Record<string, string> = {
  STALE_SESSION:
    "أُعيد تشغيل التطبيق وانتهت جلسة هذا التبويب. أعد تحميل الصفحة قبل المحاولة مرة أخرى.",
  PHOTO_CONSENT_NOT_RECORDED:
    "لم تُسجّل الموافقة بعد. يمكن حفظ البيانات محليًا، لكن إرسال مرجع مصوّر سيبقى محظورًا.",
  PHOTO_CONSENT_NOT_GRANTED:
    "الموافقة المسجّلة لا تسمح بإرسال الصور. غيّر القرار فقط بعد الرجوع إلى العميل.",
  FAMILY_SCOPE_MISMATCH: "هذه الشخصية لا تنتمي إلى العائلة المحددة.",
  FAMILY_ANCHOR_REQUIRED:
    "أضف الطفل محور العائلة أولًا، ثم يمكنك إضافة بقية الأعضاء.",
  FAMILY_ANCHOR_ARCHIVED:
    "الطفل محور العائلة مؤرشف. استعده قبل إضافة أعضاء جدد.",
  FAMILY_ANCHOR_IMMUTABLE:
    "لا يمكن تغيير الطفل محور العائلة أو علاقته بعد تعيينه.",
  STALE_VERSION_HEAD:
    "تغيّرت النسخة الحالية في تبويب آخر. حدّث البيانات ثم أعد التعديل.",
  DUPLICATE_VERSION_ID: "تعذّر حفظ نسخة مكررة. حدّث البيانات وحاول مرة أخرى.",
  DUPLICATE_DECISION_REQUIRED:
    "تغيّرت نتيجة فحص التشابه أو انتهت مهلتها. افحص السجل من جديد ثم اختر بوضوح.",
  PHOTO_UNSUPPORTED_TYPE: "نوع الملف غير مدعوم. استخدم HEIC أو JPEG أو PNG.",
  PHOTO_DECODE_FAILED: "تعذّر قراءة الصورة. اختر ملفًا سليمًا آخر.",
  PHOTO_FILE_TOO_LARGE: "حجم الصورة أكبر من الحد المضبوط في الإعدادات.",
  PHOTO_PIXEL_LIMIT_EXCEEDED: "دقة الصورة أكبر من الحد المضبوط في الإعدادات.",
  PHOTO_SUBJECT_SELECTION_REQUIRED: "حدّد الشخص المقصود داخل الصورة قبل الحفظ.",
  PHOTO_RESERVATION_NOT_FOUND:
    "انتهت مهلة فحص الصورة أو أُعيد تشغيل التطبيق. اختر الصورة وافحصها من جديد.",
  INVALID_INPUT: "راجع الحقول المطلوبة والقيم المدخلة.",
  REQUEST_FAILED: "تعذّر إكمال الطلب المحلي. حاول مرة أخرى.",
};

export function relationshipLabel(
  value: RelationshipType | CharacterProfile["relationship"],
): string {
  if (
    typeof value !== "string" &&
    value.type === "custom" &&
    value.customLabel?.trim()
  )
    return value.customLabel.trim();
  const type = typeof value === "string" ? value : value.type;
  return relationshipOptions.find((item) => item.value === type)?.label ?? type;
}

export function sourceModeLabel(value: SourceMode): string {
  return sourceModeOptions.find((item) => item.value === value)?.label ?? value;
}

export function warningLabel(code: PhotoWarningCode): string {
  return warningLabels[code];
}

export function libraryError(reason: unknown): string {
  if (reason instanceof ApiError) {
    if (reason.category === "stale_session") return errorLabels.STALE_SESSION;
    return errorLabels[reason.code] ?? errorLabels.REQUEST_FAILED;
  }
  return errorLabels.REQUEST_FAILED;
}

export function formatLibraryDate(value: string): string {
  return new Intl.DateTimeFormat("ar-EG-u-nu-latn", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function emptyCharacterProfile(
  relationship: RelationshipType = "main_child",
): CharacterProfile {
  return {
    name: "",
    nickname: "",
    relationship: { type: relationship },
    appearanceDescription: "",
    ageOrRange: "",
    gender: "",
    skinTone: "",
    hair: "",
    eyeColor: "",
    relativeHeight: "",
    build: "",
    distinguishingFeatures: [],
    glasses: "",
    hijab: "",
    accessories: [],
    interests: [],
    favoriteObjects: [],
    favoriteColor: "",
    personalityTraits: [],
    speakingStyle: "",
    notes: "",
    sourceMode: "description",
    referencePhotoIds: [],
    traits: {},
  };
}

export function splitList(value: string): string[] {
  return value
    .split(/[،,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinList(value: string[]): string {
  return value.join("، ");
}
