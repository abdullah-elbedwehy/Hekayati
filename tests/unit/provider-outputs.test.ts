import { describe, expect, it } from "vitest";

import {
  parseStructuredOutput,
  structuredOutputSchemas,
} from "../../src/providers/structured-outputs.js";
import {
  CHARACTER_A,
  generationTask,
  outputFixture,
} from "../helpers/provider-fixtures.js";

describe("structured provider outputs", () => {
  it("accepts all five schema-v1 fixtures with request-aware checks", () => {
    for (const schemaId of Object.keys(structuredOutputSchemas)) {
      const result = parseStructuredOutput(
        schemaId as keyof typeof structuredOutputSchemas,
        JSON.stringify(outputFixture(schemaId as any)),
        generationTask(schemaId as any),
      );
      expect(result, schemaId).toMatchObject({ ok: true });
    }
  });

  it("separates malformed JSON and unknown keys for every output schema", () => {
    for (const schemaId of Object.keys(structuredOutputSchemas) as Array<
      keyof typeof structuredOutputSchemas
    >) {
      const malformed = parseStructuredOutput(
        schemaId,
        "{private malformed",
        generationTask(schemaId),
      );
      expect(malformed, schemaId).toMatchObject({
        ok: false,
        failure: { category: "malformed_output" },
      });
      const unknown = {
        ...(outputFixture(schemaId) as object),
        alien: "PRIVATE-ALIEN-CANARY",
      };
      const invalid = parseStructuredOutput(
        schemaId,
        JSON.stringify(unknown),
        generationTask(schemaId),
      );
      expect(invalid, schemaId).toMatchObject({
        ok: false,
        failure: { category: "output_validation_failed" },
      });
      expect(JSON.stringify({ malformed, invalid })).not.toContain(
        "PRIVATE-ALIEN-CANARY",
      );
      expect(JSON.stringify(malformed)).not.toContain("private malformed");
    }
  });

  it("rejects page budget, contiguity, and alien speaker mismatches", () => {
    const plan = outputFixture("StoryPlan") as any;
    plan.arc[0].pagesEstimate = 2;
    expect(
      parseStructuredOutput(
        "StoryPlan",
        JSON.stringify(plan),
        generationTask("StoryPlan"),
      ),
    ).toMatchObject({ ok: false });

    const story = outputFixture("StoryText") as any;
    story.pages[1].pageNumber = 3;
    story.pages[0].dialogue[0].speaker = {
      characterId: "alien",
      characterVersionId: "alien-version",
    };
    expect(
      parseStructuredOutput(
        "StoryText",
        JSON.stringify(story),
        generationTask("StoryText"),
      ),
    ).toMatchObject({
      ok: false,
      failure: { category: "output_validation_failed" },
    });
  });

  it("rejects foreign looks and incomplete page reference plans", () => {
    const scenes = outputFixture("SceneList") as any;
    scenes.scenes[0].perCharacter[0].lookId = "foreign-look";
    expect(
      parseStructuredOutput(
        "SceneList",
        JSON.stringify(scenes),
        generationTask("SceneList"),
      ),
    ).toMatchObject({ ok: false });

    const prompt = outputFixture("PagePrompt") as any;
    prompt.referencePlan = [
      { characterRef: CHARACTER_A, useSheetViews: ["face"] },
    ];
    expect(
      parseStructuredOutput(
        "PagePrompt",
        JSON.stringify(prompt),
        generationTask("PagePrompt"),
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects participant sets, prompt constraints, review refs, and word budgets", () => {
    const plan = outputFixture("StoryPlan") as any;
    plan.characterArcs.pop();
    expectInvalid("StoryPlan", plan);

    const story = outputFixture("StoryText") as any;
    story.pages[0].narrative = "قصير";
    expectInvalid("StoryText", story);

    const scenes = outputFixture("SceneList") as any;
    scenes.scenes[0].perCharacter.pop();
    expectInvalid("SceneList", scenes);

    const prompt = outputFixture("PagePrompt") as any;
    const promptTask = generationTask("PagePrompt");
    if (promptTask.schemaId !== "PagePrompt") throw new Error("fixture");
    prompt.pageNumber = 2;
    prompt.negativeConstraints.pop();
    prompt.prompt = `Disney ${promptTask.payload.narrativeText}`;
    expectInvalid("PagePrompt", prompt);

    const review = outputFixture("ReviewFindings") as any;
    review.findings[0].pageNumber = 3;
    review.findings[0].refId = "foreign-artifact";
    expectInvalid("ReviewFindings", review);
  });
});

function expectInvalid(
  schemaId: keyof typeof structuredOutputSchemas,
  output: unknown,
): void {
  expect(
    parseStructuredOutput(
      schemaId,
      JSON.stringify(output),
      generationTask(schemaId),
    ),
  ).toMatchObject({
    ok: false,
    failure: { category: "output_validation_failed" },
  });
}
