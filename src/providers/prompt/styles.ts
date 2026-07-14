import { z } from "zod";

export const styleIdSchema = z.enum([
  "modern_cartoon",
  "colorful_2d",
  "soft_watercolor",
]);

export type StyleId = z.infer<typeof styleIdSchema>;

export const MANDATORY_NEGATIVE_CONSTRAINTS = Object.freeze([
  "no_extra_people",
  "no_story_text",
  "no_onomatopoeia",
  "no_photoreal_face",
] as const);

export interface StyleConfig {
  id: StyleId;
  version: "1";
  label: string;
  directive: string;
  palette: string;
  composition: string;
  negativeConstraints: readonly string[];
}

const styles: Record<StyleId, StyleConfig> = {
  modern_cartoon: {
    id: "modern_cartoon",
    version: "1",
    label: "كرتون عصري",
    directive: "رسوم قصص أطفال أصلية بخطوط واضحة وأشكال ودودة وتعبير حيوي.",
    palette: "ألوان حمضيات دافئة مع تباين واضح ومريح.",
    composition: "تكوين بسيط يبرز الفعل والشخصيات من غير ازدحام.",
    negativeConstraints: MANDATORY_NEGATIVE_CONSTRAINTS,
  },
  colorful_2d: {
    id: "colorful_2d",
    version: "1",
    label: "ثنائي الأبعاد ملوّن",
    directive: "رسم ثنائي الأبعاد أصلي بطبقات لونية مرحة وملامس ورقية خفيفة.",
    palette: "ألوان مبهجة متوازنة تحافظ على وضوح لون البشرة والملابس.",
    composition: "مساحات مقروءة وعمق لطيف يناسب صفحة كتاب أطفال.",
    negativeConstraints: MANDATORY_NEGATIVE_CONSTRAINTS,
  },
  soft_watercolor: {
    id: "soft_watercolor",
    version: "1",
    label: "ألوان مائية ناعمة",
    directive: "ألوان مائية أصلية ناعمة بحواف رقيقة وملمس يدوي دافئ.",
    palette: "درجات مائية هادئة مع بؤرة لونية واضحة حول الشخصيات.",
    composition: "تكوين شاعري بسيط مع فراغ بصري آمن للنص خارج الرسم.",
    negativeConstraints: MANDATORY_NEGATIVE_CONSTRAINTS,
  },
};

export function styleConfig(id: StyleId): StyleConfig {
  return styles[styleIdSchema.parse(id)];
}

export function allStyleConfigs(): StyleConfig[] {
  return styleIdSchema.options.map((id) => styleConfig(id));
}
