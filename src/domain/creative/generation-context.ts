import type { ProjectWorkspace, SceneContent } from "../authoring/index.js";
import type { FamilyScope, LibraryService } from "../library/index.js";
import {
  generationTaskV1Schema,
  type GenerationTaskV1,
} from "../../contracts/generation-task.js";
import type {
  PagePrompt,
  SceneList,
  StoryPlan,
  StoryText,
} from "./output-types.js";

const commonNegativeConstraints = [
  "ممنوع اختراع شخصيات أو أشخاص إضافيين",
  "ممنوع وضع نص الحكاية داخل الرسم",
  "ممنوع اللوم أو الإهانة أو الوعظ المباشر",
  "ممنوع تقليد فنان حي أو شخصية محمية",
];

type TaskCommon = Pick<
  GenerationTaskV1,
  | "schemaVersion"
  | "expectedOutputSchemaVersion"
  | "inputVersionRefs"
  | "participants"
  | "languageDirectives"
  | "contentBoundaries"
  | "negativeConstraints"
>;

export function buildStoryPlanTask(
  workspace: ProjectWorkspace,
  library: LibraryService,
): GenerationTaskV1 {
  const common = taskCommon(workspace, library);
  const config = workspace.version.storyConfig;
  return generationTaskV1Schema.parse({
    ...common,
    schemaId: "StoryPlan",
    payload: {
      pageCount: workspace.scenes.length,
      workingTitle: config.title,
      premise: storyPremise(workspace),
      hiddenGoal: hiddenGoal(config.hiddenGoal),
    },
  });
}

export function buildStoryTextTask(
  workspace: ProjectWorkspace,
  library: LibraryService,
  plan: StoryPlan,
): GenerationTaskV1 {
  const common = taskCommon(workspace, library);
  return generationTaskV1Schema.parse({
    ...common,
    schemaId: "StoryText",
    inputVersionRefs: {
      ...common.inputVersionRefs,
      storyPlan: workspace.project.id,
    },
    payload: {
      pageCount: workspace.scenes.length,
      planSummary: [
        plan.logline,
        plan.settingSummary,
        ...plan.arc.map((beat) => `${beat.beat}: ${beat.purpose}`),
      ].join("\n"),
      wordsPerPage: wordBudget(workspace.version.storyConfig.audienceAgeBand),
    },
  });
}

export function buildSceneListTask(
  workspace: ProjectWorkspace,
  library: LibraryService,
  story: StoryText,
): GenerationTaskV1 {
  return generationTaskV1Schema.parse({
    ...taskCommon(workspace, library),
    schemaId: "SceneList",
    payload: {
      pageCount: workspace.scenes.length,
      storyPages: story.pages.map((page) => ({
        pageNumber: page.pageNumber,
        narrative: page.narrative,
      })),
    },
  });
}

export function buildPagePromptTask(
  workspace: ProjectWorkspace,
  library: LibraryService,
  sceneList: SceneList,
  story: StoryText,
  pageNumber: number,
): GenerationTaskV1 {
  const scene = sceneList.scenes.find((item) => item.pageNumber === pageNumber);
  const storyPage = story.pages.find((item) => item.pageNumber === pageNumber);
  if (!scene || !storyPage) throw new Error("CREATIVE_PAGE_OUTPUT_MISSING");
  return generationTaskV1Schema.parse({
    ...taskCommon(workspace, library),
    schemaId: "PagePrompt",
    payload: {
      pageNumber,
      scene: {
        description: scene.description,
        participantRefs: scene.participants,
        environment: scene.environment,
        composition: scene.composition,
        cameraFraming: scene.cameraFraming,
      },
      styleId: workspace.version.storyConfig.illustrationStyleId,
      narrativeText: storyPage.narrative,
    },
  });
}

export function buildReviewFindingsTask(
  workspace: ProjectWorkspace,
  library: LibraryService,
  artifactRefs: string[],
): GenerationTaskV1 {
  return generationTaskV1Schema.parse({
    ...taskCommon(workspace, library),
    schemaId: "ReviewFindings",
    payload: {
      pageCount: workspace.scenes.length,
      artifactRefs,
    },
  });
}

export function generatedSceneContents(
  scenes: SceneList,
  story: StoryText,
): Array<{ storyPageIndex: number; content: SceneContent }> {
  return scenes.scenes.map((scene) => {
    const storyPage = story.pages.find(
      (page) => page.pageNumber === scene.pageNumber,
    );
    if (!storyPage) throw new Error("CREATIVE_PAGE_OUTPUT_MISSING");
    return {
      storyPageIndex: scene.pageNumber,
      content: {
        purpose: scene.purpose,
        description: scene.description,
        documentSegments: scene.perCharacter.map((participant) => ({
          type: "mention" as const,
          characterId: participant.characterRef.characterId,
          props: {
            action: participant.action,
            emotion: participant.emotion,
            position: participant.position ?? null,
            framing: participant.framing ?? null,
            lookId: participant.lookId ?? null,
            heldObject: participant.heldObject ?? null,
            gazeTarget: participant.gazeTarget ?? null,
            speaks: participant.speaks,
            dialogue:
              storyPage.dialogue.find(
                (line) =>
                  line.speaker.characterId ===
                  participant.characterRef.characterId,
              )?.line ?? null,
          },
        })),
        environment: scene.environment,
        timeOfDay: scene.timeOfDay,
        composition: scene.composition,
        cameraFraming: scene.cameraFraming,
        narrativeText: storyPage.narrative,
        dialogue: storyPage.dialogue.map((line) => ({
          speakerCharacterId: line.speaker.characterId,
          text: line.line,
        })),
        twoImageMoment: scene.twoImageMoment,
      },
    };
  });
}

export function compiledImageScene(sceneList: SceneList, pageNumber: number) {
  const scene = sceneList.scenes.find((item) => item.pageNumber === pageNumber);
  if (!scene) throw new Error("CREATIVE_PAGE_OUTPUT_MISSING");
  return {
    pageNumber,
    description: scene.description,
    participants: scene.perCharacter.map((participant) => ({
      characterRef: participant.characterRef,
      action: participant.action,
      emotion: participant.emotion,
      lookId: participant.lookId ?? null,
    })),
    environment: scene.environment,
    composition: scene.composition,
    cameraFraming: scene.cameraFraming,
  };
}

export function promptText(output: PagePrompt): string {
  return output.prompt;
}

export function withGenerationInputRefs(
  task: GenerationTaskV1,
  refs: Record<string, string>,
): GenerationTaskV1 {
  return generationTaskV1Schema.parse({
    ...task,
    inputVersionRefs: { ...task.inputVersionRefs, ...refs },
  });
}

function taskCommon(
  workspace: ProjectWorkspace,
  library: LibraryService,
): TaskCommon {
  const scope: FamilyScope = {
    customerId: workspace.project.customerId,
    familyId: workspace.project.familyId,
  };
  return {
    schemaVersion: 1 as const,
    expectedOutputSchemaVersion: 1 as const,
    inputVersionRefs: {
      projectVersion: workspace.version.id,
      storyVersion: workspace.storyVersion.id,
      ...Object.fromEntries(
        workspace.version.storyConfig.participants.map((participant, index) => [
          `character${index + 1}`,
          participant.characterVersionId,
        ]),
      ),
    },
    participants: taskParticipants(workspace, library, scope),
    languageDirectives: {
      storyDialect: "egyptian_arabic" as const,
      register: registerForAge(workspace.version.storyConfig.audienceAgeBand),
      ageBand: workspace.version.storyConfig.audienceAgeBand,
    },
    contentBoundaries: contentBoundaries(workspace),
    negativeConstraints: commonNegativeConstraints,
  };
}

function taskParticipants(
  workspace: ProjectWorkspace,
  library: LibraryService,
  scope: FamilyScope,
): GenerationTaskV1["participants"] {
  return workspace.version.storyConfig.participants.map((participant) => {
    const version = library.getCharacterVersion(
      scope,
      participant.characterId,
      participant.characterVersionId,
    );
    return {
      characterRef: {
        characterId: participant.characterId,
        characterVersionId: participant.characterVersionId,
      },
      displayLabel: version.profile.nickname || version.profile.name,
      narrativeRole: participant.narrativeRole,
      appearanceDescription:
        version.profile.appearanceDescription.trim() ||
        "هوية بصرية مثبتة في المرجع المعتمد",
      availableLookIds: library
        .listLooks(scope, participant.characterId, { includeArchived: true })
        .map((look) => look.id),
      traits: participantTraits(version.profile),
    };
  });
}

function participantTraits(profile: {
  personalityTraits: string[];
  interests: string[];
  speakingStyle: string | null;
}): Record<string, string> {
  const entries: Array<[string, string | null]> = [
    ["personality", profile.personalityTraits.join("، ")],
    ["interests", profile.interests.join("، ")],
    ["speakingStyle", profile.speakingStyle],
  ];
  return Object.fromEntries(
    entries.flatMap(([key, value]) =>
      value?.trim() ? [[key, value.slice(0, 240)]] : [],
    ),
  );
}

function storyPremise(workspace: ProjectWorkspace): string {
  const config = workspace.version.storyConfig;
  return (
    config.customStory?.premise.trim() ||
    config.customNotes.trim() ||
    config.occasion.trim() ||
    `حكاية أصلية بعنوان ${config.title}`
  );
}

function hiddenGoal(
  goal: ProjectWorkspace["version"]["storyConfig"]["hiddenGoal"],
): string | null {
  if (!goal) return null;
  return goal.goal === "custom" ? goal.customGoal : goal.goal;
}

function contentBoundaries(workspace: ProjectWorkspace): string[] {
  const custom = workspace.version.storyConfig.customStory?.contentBoundaries;
  return custom && custom.length > 0
    ? custom
    : ["محتوى آمن ومناسب للطفل من غير لوم أو تخويف أو بيانات اتصال"];
}

function wordBudget(ageBand: "age_3_5" | "age_6_8" | "age_9_12") {
  if (ageBand === "age_3_5") return { minimum: 12, maximum: 35 };
  if (ageBand === "age_6_8") return { minimum: 25, maximum: 70 };
  return { minimum: 40, maximum: 110 };
}

function registerForAge(ageBand: "age_3_5" | "age_6_8" | "age_9_12") {
  if (ageBand === "age_3_5") return "مصري بسيط جدًا وجمل قصيرة";
  if (ageBand === "age_6_8") return "مصري طبيعي بسيط من غير سلانج زائد";
  return "مصري طبيعي غني وواضح من غير ترندات عابرة";
}
