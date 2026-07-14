import {
  storyTemplateContentSchema,
  type StoryTemplateContent,
} from "./schemas.js";

export interface SeedTemplateDefinition {
  seedKey:
    | "space_adventure"
    | "treasure_island"
    | "dinosaur_world"
    | "imaginary_city_rescue"
    | "underwater_journey"
    | "unforgettable_birthday"
    | "fully_custom";
  content: StoryTemplateContent;
}

const ageRules: StoryTemplateContent["ageAdaptationRules"] = [
  { ageBand: "age_3_5", guidance: "هدف واحد، صور واضحة، وتكرار مطمئن." },
  { ageBand: "age_6_8", guidance: "محاولتان واضحتان وسبب ونتيجة بسيطان." },
  { ageBand: "age_9_12", guidance: "دوافع أعمق واختيار له نتيجة من غير وعظ." },
];

const heroSlot: StoryTemplateContent["roleSlots"][number] = {
  slot: "hero",
  label: "البطل",
  required: true,
  requiredRelationship: null,
  narrativeRole: "قائد الحكاية",
};

export const seedTemplateDefinitions: SeedTemplateDefinition[] = [
  defineSeed("space_adventure", {
    name: "مغامرة الفضاء",
    premise: "البطل يفهم إشارة بعيدة ويقود رحلة آمنة لمساعدة كوكب لطيف.",
    structure: beats(
      "ظهور الإشارة واختيار فهمها.",
      "تجهيز الرحلة واكتشاف المشكلة الحقيقية.",
      "حل تعاوني من غير قوة مفاجئة.",
      "عودة دافئة ومع البطل ذكرى صغيرة.",
    ),
    environments: ["غرفة ليلية", "مركبة فضائية", "كوكب بحدائق مضيئة"],
    roleSlots: slots("شريك الاكتشاف"),
    variables: variables("signal_source", "مصدر الإشارة", "نجمة بتومض"),
    possibleHiddenGoals: ["الثقة", "الشجاعة", "التعاون", "المسؤولية"],
    sceneGuidance: ["الفضاء ملوّن ومطمئن.", "كل مشارك له فعل واضح."],
    ageAdaptationRules: ageRules,
    contentBoundaries: ["لا أسلحة أو حرب.", "لا ضياع أو اختناق مرعب."],
    endingPatterns: ["وداع سكان الكوكب.", "رؤية الأرض من بعيد."],
  }),
  defineSeed("treasure_island", {
    name: "جزيرة الكنز",
    premise: "خريطة تقود الفريق لألغاز طبيعية وكنز نافع يشاركون أثره.",
    structure: beats(
      "العثور على الخريطة.",
      "اتباع ثلاث علامات في الجزيرة.",
      "اختيار طريق آمن وحل اللغز.",
      "اكتشاف كنز قيمته في المشاركة.",
    ),
    environments: ["رصيف صغير", "شاطئ ذهبي", "غابة نخيل", "كهف مضيء"],
    roleSlots: slots("ملاحظ العلامات"),
    variables: variables("treasure", "الكنز", "بذور نادرة ودفتر حكايات"),
    possibleHiddenGoals: ["المشاركة", "الصبر", "القراءة", "التعاون"],
    sceneGuidance: ["المسار المكاني مفهوم.", "الألغاز مرئية وقابلة للحل."],
    ageAdaptationRules: ageRules,
    contentBoundaries: ["لا قراصنة عنيفين.", "لا سرقة أو غرق أو أسلحة."],
    endingPatterns: ["زراعة بذور الكنز.", "ترك الجزيرة أنظف."],
  }),
  defineSeed("dinosaur_world", {
    name: "عالم الديناصورات",
    premise: "بوابة خيالية تقود لوادٍ قديم ومساعدة صغير يرجع لقطيعه.",
    structure: beats(
      "فتح البوابة ووضع قاعدة رجوع.",
      "ملاحظة ديناصورات مسالمة.",
      "مساعدة صغير عند عائق طبيعي.",
      "لم الشمل والعودة الآمنة.",
    ),
    environments: ["ركن علوم", "وادٍ أخضر", "بحيرة ضحلة", "عش دافئ"],
    roleSlots: slots("مسجل الملاحظات"),
    variables: variables("hatchling_kind", "نوع الصغير", "ديناصور نباتي صغير"),
    possibleHiddenGoals: ["حب التعلم", "الرفق", "الصبر", "طلب المساعدة"],
    sceneGuidance: ["الديناصورات حيوانات لا وحوش.", "الملاحظة قبل الاقتراب."],
    ageAdaptationRules: ageRules,
    contentBoundaries: ["لا افتراس أو دم.", "لا أخذ بيضة أو استخدام سلاح."],
    endingPatterns: ["طبعة قدم في الكراسة.", "تلويحة من بعيد."],
  }),
  defineSeed("imaginary_city_rescue", {
    name: "إنقاذ مدينة خيالية",
    premise: "مدينة تفقد جزءًا من بهجتها والبطل ينظم خطة تجمع مهارات أهلها.",
    structure: beats(
      "وصول رسالة المدينة.",
      "سماع الآراء ورسم المشكلة.",
      "توزيع الأدوار وتجربة حل آمن.",
      "عودة البهجة وشكر الجميع.",
    ),
    environments: ["بوابة المدينة", "ميدان مرح", "ورشة", "حديقة"],
    roleSlots: slots("جامع الأفكار"),
    variables: variables("city_name", "اسم المدينة", "مدينة الفوانيس"),
    possibleHiddenGoals: ["القيادة المتعاونة", "الاستماع", "المسؤولية"],
    sceneGuidance: ["البطل يستمع ولا يأمر.", "الحل نتيجة أدوار محددة."],
    ageAdaptationRules: ageRules,
    contentBoundaries: ["لا حرب أو إصابات.", "لا تقليد مدينة أو بطل معروف."],
    endingPatterns: ["لوحة شكر بالأدوار.", "عودة الضوء بالتدريج."],
  }),
  defineSeed("underwater_journey", {
    name: "رحلة تحت الماء",
    premise: "البطل يستكشف الشعاب من مركبة آمنة ويساعد الموطن من بعيد.",
    structure: beats(
      "تجهيز المركبة وقواعد الملاحظة.",
      "اكتشاف الشعاب وعلامة المشكلة.",
      "فهم التيار وتنفيذ مساعدة آمنة.",
      "العودة وتوثيق ما يستحق الحماية.",
    ),
    environments: ["شاطئ هادئ", "مركبة زجاجية", "شعاب", "أعشاب بحرية"],
    roleSlots: slots("مسجل الكائنات"),
    variables: variables("sea_friend", "الصديق البحري", "سلحفاة فضولية"),
    possibleHiddenGoals: ["الرفق", "المسؤولية", "الصبر", "التعاون"],
    sceneGuidance: ["الحركة هادئة.", "الحيوانات ليست أدوات أو ممتلكات."],
    ageAdaptationRules: ageRules,
    contentBoundaries: ["لا غرق أو هجوم مرعب.", "لا جمع مرجان أو حيوان."],
    endingPatterns: ["ألبوم رسومات.", "موجة توديع من بعيد."],
  }),
  defineSeed("unforgettable_birthday", {
    name: "عيد ميلاد لا يُنسى",
    premise: "تفصيلة في الاحتفال تتعطل فيحوّلها البطل ليوم دافئ وشخصي.",
    structure: beats(
      "اختيار نشاط يحبه البطل.",
      "تعطل بسيط من غير لوم.",
      "صنع بديل متاح معًا.",
      "لحظة ذكرى أهم من الزينة.",
    ),
    environments: ["البيت", "ركن تجهيز", "مكان النشاط", "طاولة بسيطة"],
    roleSlots: slots("شريك النشاط"),
    variables: variables("favorite_activity", "النشاط المفضل", "بحث عن ألوان"),
    possibleHiddenGoals: ["تقبل التغيير", "الامتنان", "المشاركة"],
    sceneGuidance: ["الحب لا يقاس بالهدايا.", "التعطل فرصة مرحة لا إحراج."],
    ageAdaptationRules: ageRules,
    contentBoundaries: ["لا مقالب مخيفة.", "لا مقارنة أو ضغط أو علامة تجارية."],
    endingPatterns: ["صندوق ذكريات ورقية.", "لحظة هادئة بعد الاحتفال."],
  }),
  defineSeed("fully_custom", {
    name: "قصة مخصّصة بالكامل",
    premise: "هيكل منظم يحوّل فكرة الأسرة إلى قصة أصلية بلا تخمين للناقص.",
    structure: beats(
      "حدث افتتاحي يغير يوم البطل.",
      "محاولات مرتبة في المنتصف.",
      "اختيار أو اكتشاف أساسي.",
      "نتيجة وعودة ووداع.",
    ),
    environments: ["بيئة يحددها المشغّل"],
    roleSlots: slots("رفيق اختياري"),
    variables: customVariables(),
    possibleHiddenGoals: ["أي هدف مختار", "هدف مخصص بلا لوم"],
    sceneGuidance: ["لا تخمّن الحقول الناقصة.", "كل مشارك مختار له وظيفة."],
    ageAdaptationRules: ageRules,
    contentBoundaries: [
      "حد واحد على الأقل يحدده المشغّل.",
      "لا وصم أو بيانات اتصال.",
    ],
    endingPatterns: ["عودة دافئة.", "اكتشاف هادئ.", "احتفال صغير."],
  }),
];

function defineSeed(
  seedKey: SeedTemplateDefinition["seedKey"],
  content: StoryTemplateContent,
): SeedTemplateDefinition {
  return { seedKey, content: storyTemplateContentSchema.parse(content) };
}

function beats(...purposes: string[]): StoryTemplateContent["structure"] {
  const keys = ["beginning", "discovery", "solution", "ending"];
  return purposes.map((purpose, index) => ({ key: keys[index], purpose }));
}

function slots(friendRole: string): StoryTemplateContent["roleSlots"] {
  return [
    heroSlot,
    {
      slot: "companion",
      label: "الرفيق",
      required: false,
      requiredRelationship: null,
      narrativeRole: friendRole,
    },
    {
      slot: "family_support",
      label: "مساند من العائلة",
      required: false,
      requiredRelationship: null,
      narrativeRole: "مساند",
    },
  ];
}

function variables(
  key: string,
  label: string,
  defaultValue: string,
): StoryTemplateContent["variables"] {
  return [{ key, label, type: "text", required: true, defaultValue }];
}

function customVariables(): StoryTemplateContent["variables"] {
  return [
    variable("custom_premise", "فكرة القصة", "long_text"),
    variable("beginning_beat", "البداية", "long_text"),
    variable("middle_beat", "المنتصف", "long_text"),
    variable("ending_beat", "النهاية", "long_text"),
    variable("content_boundaries", "حدود المحتوى", "text_list"),
  ];
}

function variable(
  key: string,
  label: string,
  type: "long_text" | "text_list",
): StoryTemplateContent["variables"][number] {
  return { key, label, type, required: true, defaultValue: null };
}
