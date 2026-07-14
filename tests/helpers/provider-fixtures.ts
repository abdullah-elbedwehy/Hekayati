import type {
  GenerationTaskV1,
  StructuredSchemaId,
} from "../../src/providers/generation-task.js";
import { generationTaskV1Schema } from "../../src/providers/generation-task.js";

export const CHARACTER_A = {
  characterId: "character-a",
  characterVersionId: "character-version-a",
} as const;

export const CHARACTER_B = {
  characterId: "character-b",
  characterVersionId: "character-version-b",
} as const;

export function generationTask(
  schemaId: StructuredSchemaId = "StoryPlan",
): GenerationTaskV1 {
  const common = {
    schemaVersion: 1 as const,
    expectedOutputSchemaVersion: 1 as const,
    schemaId,
    inputVersionRefs: {
      project: "project-version-1",
      characterA: CHARACTER_A.characterVersionId,
      characterB: CHARACTER_B.characterVersionId,
    },
    participants: [
      {
        characterRef: CHARACTER_A,
        displayLabel: "نور",
        narrativeRole: "البطلة",
        appearanceDescription: "طفلة بشعر أسود قصير ونظارة مستديرة",
        availableLookIds: ["look-a"],
        traits: { courage: "فضولية وشجاعة" },
      },
      {
        characterRef: CHARACTER_B,
        displayLabel: "عمر",
        narrativeRole: "الصديق",
        appearanceDescription: "طفل بشعر بني مجعد وقميص أخضر",
        availableLookIds: ["look-b"],
        traits: { humor: "خفيف الظل" },
      },
    ],
    languageDirectives: {
      storyDialect: "egyptian_arabic" as const,
      register: "عربي بسيط",
      ageBand: "age_6_8",
    },
    contentBoundaries: ["لا خوف شديد"],
    negativeConstraints: ["لا لوم أو وعظ مباشر"],
  };
  const payloads = {
    StoryPlan: {
      pageCount: 2,
      workingTitle: "مغامرة نور",
      premise: "رحلة لطيفة للبحث عن طائرة ورقية",
      hiddenGoal: "الثقة بالنفس",
    },
    StoryText: {
      pageCount: 2,
      planSummary: "تبدأ الرحلة ثم يجد الصديقان الطائرة",
      wordsPerPage: { minimum: 5, maximum: 80 },
    },
    SceneList: {
      pageCount: 2,
      storyPages: [
        { pageNumber: 1, narrative: "خرجت نور تدور على الطيارة." },
        { pageNumber: 2, narrative: "لقيتها مع عمر وفرحوا سوا." },
      ],
    },
    PagePrompt: {
      pageNumber: 1,
      scene: {
        description: "نور وعمر في حديقة واسعة",
        participantRefs: [CHARACTER_A, CHARACTER_B],
        environment: "حديقة صباحية",
        composition: "لقطة متوسطة",
        cameraFraming: "eye-level",
      },
      styleId: "modern_cartoon" as const,
      narrativeText: "خرجت نور تدور على الطيارة.",
    },
    ReviewFindings: {
      pageCount: 2,
      artifactRefs: ["story-version-1", "scene-version-1"],
    },
  } satisfies Record<StructuredSchemaId, object>;
  return generationTaskV1Schema.parse({
    ...common,
    schemaId,
    payload: payloads[schemaId],
  });
}

export function outputFixture(schemaId: StructuredSchemaId): unknown {
  switch (schemaId) {
    case "StoryPlan":
      return {
        schemaVersion: 1,
        title: "مغامرة نور",
        logline: "نور وعمر بيدوروا على طيارة ورق.",
        arc: [
          { beat: "البحث", purpose: "بداية الرحلة", pagesEstimate: 1 },
          { beat: "اللقاء", purpose: "نهاية دافئة", pagesEstimate: 1 },
        ],
        settingSummary: "حديقة مصرية صباحية",
        characterArcs: [
          { characterRef: CHARACTER_A, arcNote: "تجرب وتحاول" },
          { characterRef: CHARACTER_B, arcNote: "يساعد بهدوء" },
        ],
        hiddenGoalWeave: "يظهر الهدف من التصرفات من غير وعظ.",
        toneNotes: "خفيف ودافئ",
        pageBudget: { storyPages: 2 },
      };
    case "StoryText":
      return {
        schemaVersion: 1,
        pages: [
          {
            pageNumber: 1,
            narrative: "خرجت نور تدور على الطيارة الورق في الجنينة.",
            dialogue: [{ speaker: CHARACTER_A, line: "هنلاقيها!" }],
          },
          {
            pageNumber: 2,
            narrative: "قابلت عمر ولقوا الطيارة وفرحوا سوا جدًا.",
            dialogue: [{ speaker: CHARACTER_B, line: "أهي هناك!" }],
          },
        ],
      };
    case "SceneList":
      return {
        schemaVersion: 1,
        scenes: [1, 2].map((pageNumber) => ({
          pageNumber,
          purpose: pageNumber === 1 ? "البحث" : "اللقاء",
          description: "مشهد بصري من غير كتابة",
          participants: [CHARACTER_A, CHARACTER_B],
          perCharacter: [
            {
              characterRef: CHARACTER_A,
              action: "تبحث",
              emotion: "متحمسة",
              position: "يمين",
              framing: "متوسط",
              lookId: "look-a",
              heldObject: null,
              gazeTarget: "السماء",
              speaks: false,
            },
            {
              characterRef: CHARACTER_B,
              action: "يشاور",
              emotion: "سعيد",
              position: "يسار",
              framing: "متوسط",
              lookId: "look-b",
              heldObject: null,
              gazeTarget: "الطائرة",
              speaks: pageNumber === 2,
            },
          ],
          environment: "حديقة",
          timeOfDay: "صباح",
          composition: "متوازنة",
          cameraFraming: "لقطة متوسطة",
          twoImageMoment: false,
        })),
      };
    case "PagePrompt":
      return {
        schemaVersion: 1,
        pageNumber: 1,
        prompt: "نور وعمر في حديقة صباحية، أسلوب أصلي مرح.",
        negativeConstraints: [
          "no_extra_people",
          "no_story_text",
          "no_onomatopoeia",
          "no_photoreal_face",
        ],
        referencePlan: [
          { characterRef: CHARACTER_A, useSheetViews: ["face", "front"] },
          {
            characterRef: CHARACTER_B,
            useSheetViews: ["threeQuarter", "fullBody"],
          },
        ],
      };
    case "ReviewFindings":
      return {
        schemaVersion: 1,
        findings: [
          {
            scope: "page",
            refId: "scene-version-1",
            pageNumber: 1,
            category: "register_drift",
            severity: "info",
            excerpt: "هنلاقيها",
            note: "مناسب للسياق المصري.",
          },
        ],
      };
  }
}
