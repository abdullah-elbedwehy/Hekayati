import type {
  CreativeReviewCheckKey,
  CreativeReviewChecks,
} from "../../creative-types";

export const reviewChecks: Array<{
  key: CreativeReviewCheckKey;
  label: string;
  group: "identity" | "story" | "safety";
}> = [
  {
    key: "identityMatchesSheet",
    label: "الهوية تطابق الورقة المعتمدة",
    group: "identity",
  },
  { key: "outfitMatchesPlan", label: "الملابس تطابق الخطة", group: "identity" },
  {
    key: "participantsExact",
    label: "المشاركون بالعدد الصحيح",
    group: "identity",
  },
  { key: "petAnatomySafe", label: "تشريح الحيوان سليم", group: "identity" },
  {
    key: "ageAndRegisterAppropriate",
    label: "اللغة مناسبة للعمر",
    group: "story",
  },
  { key: "noInImageText", label: "لا توجد كتابة داخل الرسم", group: "story" },
  { key: "artTextConsistent", label: "الرسم متسق مع النص", group: "story" },
  {
    key: "noSexualizedChild",
    label: "لا يوجد تصوير غير ملائم للطفل",
    group: "safety",
  },
  { key: "noGraphicViolence", label: "لا يوجد عنف تصويري", group: "safety" },
  {
    key: "noDangerousInstructions",
    label: "لا توجد تعليمات خطرة",
    group: "safety",
  },
  {
    key: "noHumiliationOrPunishment",
    label: "لا يوجد إذلال أو عقاب",
    group: "safety",
  },
  {
    key: "noHateOrStereotypes",
    label: "لا توجد كراهية أو صور نمطية",
    group: "safety",
  },
  { key: "noAdultThemes", label: "لا توجد موضوعات للكبار", group: "safety" },
  { key: "noChildBlame", label: "لا يوجد لوم للطفل", group: "safety" },
  { key: "noExcessiveFear", label: "لا يوجد تخويف زائد", group: "safety" },
  {
    key: "noCopyrightCharacter",
    label: "لا توجد شخصية محمية",
    group: "safety",
  },
  {
    key: "noLivingArtistImitation",
    label: "لا يوجد تقليد لفنان حي",
    group: "safety",
  },
  { key: "noContactDetails", label: "لا توجد بيانات تواصل", group: "safety" },
  {
    key: "noCrossCustomerData",
    label: "لا توجد بيانات من عميل آخر",
    group: "safety",
  },
];

export function emptyChecks(value = false): CreativeReviewChecks {
  return Object.fromEntries(
    reviewChecks.map((item) => [item.key, value]),
  ) as CreativeReviewChecks;
}

export function groupLabel(group: "identity" | "story" | "safety") {
  if (group === "identity") return "الهوية والمشاركون";
  return group === "story" ? "النص والرسم" : "السلامة والخصوصية";
}
