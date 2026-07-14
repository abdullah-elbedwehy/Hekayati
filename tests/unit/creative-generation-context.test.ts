import { afterEach, describe, expect, it } from "vitest";

import {
  pagePromptSchema,
  sceneListSchema,
  storyPlanSchema,
  storyTextSchema,
} from "../../src/contracts/creative-outputs.js";
import { resolveDataPaths } from "../../src/config/paths.js";
import {
  AuthoringService,
  type ProjectWorkspace,
} from "../../src/domain/authoring/index.js";
import {
  buildPagePromptTask,
  buildSceneListTask,
  buildStoryPlanTask,
  buildStoryTextTask,
  compiledImageScene,
  generatedSceneContents,
  promptText,
  withGenerationInputRefs,
} from "../../src/domain/creative/generation-context.js";
import { LibraryService } from "../../src/domain/library/index.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { deterministicStructuredFixture } from "../../src/providers/mock/deterministic-fixtures.js";
import { seedCreativeProject } from "../helpers/creative-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("creative generation context", () => {
  it("compiles explicit age, premise, goal, and boundary alternatives", async () => {
    const fixture = await contextFixture();
    const plan = outputSet(fixture).plan;
    const workspace = structuredClone(fixture.workspace);

    workspace.version.storyConfig.audienceAgeBand = "age_3_5";
    expect(
      storyTextPayload(buildStoryTextTask(workspace, fixture.library, plan))
        .wordsPerPage,
    ).toEqual({ minimum: 12, maximum: 35 });
    expect(
      buildStoryPlanTask(workspace, fixture.library).languageDirectives
        .register,
    ).toContain("بسيط جدًا");

    workspace.version.storyConfig.audienceAgeBand = "age_9_12";
    expect(
      storyTextPayload(buildStoryTextTask(workspace, fixture.library, plan))
        .wordsPerPage,
    ).toEqual({ minimum: 40, maximum: 110 });
    expect(
      buildStoryPlanTask(workspace, fixture.library).languageDirectives
        .register,
    ).toContain("غني");

    workspace.version.storyConfig.customStory = {
      premise: "فرضية مخصصة",
      beginningBeat: "بداية",
      middleBeat: "وسط",
      endingBeat: "نهاية",
      contentBoundaries: ["حد مخصص آمن"],
    };
    workspace.version.storyConfig.hiddenGoal = {
      goal: "custom",
      customGoal: "هدف خفي مخصص",
      presentation: "indirect",
    };
    let task = buildStoryPlanTask(workspace, fixture.library);
    expect(storyPlanPayload(task)).toMatchObject({
      premise: "فرضية مخصصة",
      hiddenGoal: "هدف خفي مخصص",
    });
    expect(task.contentBoundaries).toEqual(["حد مخصص آمن"]);

    workspace.version.storyConfig.customStory.premise = "";
    workspace.version.storyConfig.customNotes = "";
    workspace.version.storyConfig.occasion = "مناسبة بديلة";
    workspace.version.storyConfig.hiddenGoal = null;
    task = buildStoryPlanTask(workspace, fixture.library);
    expect(storyPlanPayload(task)).toMatchObject({
      premise: "مناسبة بديلة",
      hiddenGoal: null,
    });

    workspace.version.storyConfig.occasion = "";
    expect(
      storyPlanPayload(buildStoryPlanTask(workspace, fixture.library)).premise,
    ).toContain(workspace.version.storyConfig.title);
  });

  it("preserves optional scene directions, dialogue, prompts, and input refs", async () => {
    const fixture = await contextFixture();
    const outputs = outputSet(fixture);
    const sceneList = structuredClone(outputs.sceneList);
    const story = structuredClone(outputs.story);
    const participant = sceneList.scenes[0].perCharacter[0];
    participant.position = "يمين المشهد";
    participant.framing = "قريب";
    participant.lookId =
      fixture.workspace.version.storyConfig.participants[0].appearance.type ===
      "shared_look"
        ? fixture.workspace.version.storyConfig.participants[0].appearance
            .lookId
        : null;
    participant.heldObject = "منظار ورقي";
    participant.gazeTarget = "القمر";
    participant.speaks = true;
    story.pages[0].dialogue = [
      {
        speaker: participant.characterRef,
        line: "شايفة القمر!",
      },
    ];
    const parsedScenes = sceneListSchema.parse(sceneList);
    const parsedStory = storyTextSchema.parse(story);

    const content = generatedSceneContents(parsedScenes, parsedStory)[0];
    const mention = content.content.documentSegments[0];
    if (mention.type !== "mention") throw new Error("MENTION_EXPECTED");
    expect(mention.props).toMatchObject({
      position: "يمين المشهد",
      framing: "قريب",
      heldObject: "منظار ورقي",
      gazeTarget: "القمر",
      speaks: true,
      dialogue: "شايفة القمر!",
    });
    expect(compiledImageScene(parsedScenes, 1).participants[0]).toMatchObject({
      action: participant.action,
      emotion: participant.emotion,
      lookId: participant.lookId,
    });
    const promptTask = buildPagePromptTask(
      fixture.workspace,
      fixture.library,
      parsedScenes,
      parsedStory,
      1,
    );
    const pagePrompt = pagePromptSchema.parse(
      deterministicStructuredFixture(promptTask, "c".repeat(64)),
    );
    expect(promptText(pagePrompt)).toBe(pagePrompt.prompt);
    expect(
      withGenerationInputRefs(promptTask, {
        promptVersion: fixture.seed.projectVersionId,
      }).inputVersionRefs,
    ).toMatchObject({ promptVersion: fixture.seed.projectVersionId });
  });

  it("rejects missing story or scene pages before compiling successors", async () => {
    const fixture = await contextFixture();
    const { sceneList, story } = outputSet(fixture);
    const missingScene = sceneListSchema.parse({
      ...sceneList,
      scenes: sceneList.scenes.slice(1),
    });
    const missingStory = storyTextSchema.parse({
      ...story,
      pages: story.pages.slice(1),
    });
    expect(() =>
      buildPagePromptTask(
        fixture.workspace,
        fixture.library,
        missingScene,
        story,
        1,
      ),
    ).toThrowError("CREATIVE_PAGE_OUTPUT_MISSING");
    expect(() =>
      buildPagePromptTask(
        fixture.workspace,
        fixture.library,
        sceneList,
        missingStory,
        1,
      ),
    ).toThrowError("CREATIVE_PAGE_OUTPUT_MISSING");
    expect(() => generatedSceneContents(sceneList, missingStory)).toThrowError(
      "CREATIVE_PAGE_OUTPUT_MISSING",
    );
    expect(() => compiledImageScene(sceneList, 99)).toThrowError(
      "CREATIVE_PAGE_OUTPUT_MISSING",
    );
  });
});

async function contextFixture() {
  const directory = await temporaryDirectory("hekayati-context-");
  cleanups.push(directory.cleanup);
  const seed = await seedCreativeProject(directory.path, "-context");
  const store = new DocumentStore(resolveDataPaths(directory.path).database);
  cleanups.push(() => store.close());
  const library = new LibraryService(store);
  const workspace = new AuthoringService(store, library).getProjectWorkspace(
    seed.scope,
    seed.projectId,
  );
  return { seed, store, library, workspace };
}

function outputSet(fixture: {
  library: LibraryService;
  workspace: ProjectWorkspace;
}) {
  const planTask = buildStoryPlanTask(fixture.workspace, fixture.library);
  const plan = storyPlanSchema.parse(
    deterministicStructuredFixture(planTask, "a".repeat(64)),
  );
  const storyTask = buildStoryTextTask(
    fixture.workspace,
    fixture.library,
    plan,
  );
  const story = storyTextSchema.parse(
    deterministicStructuredFixture(storyTask, "b".repeat(64)),
  );
  const sceneTask = buildSceneListTask(
    fixture.workspace,
    fixture.library,
    story,
  );
  const sceneList = sceneListSchema.parse(
    deterministicStructuredFixture(sceneTask, "c".repeat(64)),
  );
  return { plan, story, sceneList };
}

function storyPlanPayload(task: ReturnType<typeof buildStoryPlanTask>) {
  if (task.schemaId !== "StoryPlan") throw new Error("STORY_PLAN_EXPECTED");
  return task.payload;
}

function storyTextPayload(task: ReturnType<typeof buildStoryTextTask>) {
  if (task.schemaId !== "StoryText") throw new Error("STORY_TEXT_EXPECTED");
  return task.payload;
}
