import { z } from "zod";

import { structuralDiagnostics, type StructuralIssue } from "./diagnostics.js";
import { makeFailure, type NormalizedFailure } from "./failures.js";
import {
  characterRefSchema,
  generationTaskV1Schema,
  structuredSchemaIdSchema,
  type CharacterRef,
  type GenerationTaskV1,
  type StructuredSchemaId,
} from "./generation-task.js";
import { checkPromptPolicy } from "./prompt/policy.js";
import { MANDATORY_NEGATIVE_CONSTRAINTS } from "./prompt/styles.js";

const text = z.string().trim().min(1).max(12_000);
const shortText = z.string().trim().min(1).max(500);
const safeId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
  .max(160);

export const storyPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().trim().min(1).max(80),
    logline: text,
    arc: z
      .array(
        z
          .object({
            beat: shortText,
            purpose: shortText,
            pagesEstimate: z.number().int().min(1).max(4),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    settingSummary: text,
    characterArcs: z
      .array(
        z.object({ characterRef: characterRefSchema, arcNote: text }).strict(),
      )
      .max(20),
    hiddenGoalWeave: text.nullable(),
    toneNotes: text,
    pageBudget: z
      .object({ storyPages: z.number().int().min(1).max(20) })
      .strict(),
  })
  .strict();

export const storyTextSchema = z
  .object({
    schemaVersion: z.literal(1),
    pages: z
      .array(
        z
          .object({
            pageNumber: z.number().int().min(1).max(20),
            narrative: text,
            dialogue: z
              .array(
                z.object({ speaker: characterRefSchema, line: text }).strict(),
              )
              .max(100),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

const perCharacterSchema = z
  .object({
    characterRef: characterRefSchema,
    action: shortText,
    emotion: shortText,
    position: shortText.nullable().optional(),
    framing: shortText.nullable().optional(),
    lookId: safeId.nullable().optional(),
    heldObject: shortText.nullable().optional(),
    gazeTarget: shortText.nullable().optional(),
    speaks: z.boolean(),
  })
  .strict();

export const sceneListSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenes: z
      .array(
        z
          .object({
            pageNumber: z.number().int().min(1).max(20),
            purpose: shortText,
            description: text,
            participants: z.array(characterRefSchema).max(20),
            perCharacter: z.array(perCharacterSchema).max(20),
            environment: text,
            timeOfDay: shortText,
            composition: text,
            cameraFraming: shortText,
            twoImageMoment: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const pagePromptSchema = z
  .object({
    schemaVersion: z.literal(1),
    pageNumber: z.number().int().min(1).max(20),
    prompt: text,
    negativeConstraints: z.array(shortText).min(4).max(40),
    referencePlan: z
      .array(
        z
          .object({
            characterRef: characterRefSchema,
            useSheetViews: z
              .array(
                z.enum([
                  "face",
                  "front",
                  "threeQuarter",
                  "fullBody",
                  "mainOutfit",
                ]),
              )
              .min(1)
              .max(5),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export const reviewFindingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    findings: z
      .array(
        z
          .object({
            scope: z.enum(["story", "page", "character"]),
            refId: safeId,
            pageNumber: z.number().int().min(1).max(20).optional(),
            category: z.enum([
              "register_drift",
              "slang_excess",
              "trend_vocab",
              "shaming",
              "lecture",
              "age_inappropriate",
              "fear_excess",
              "safety",
              "copyright_similarity",
              "contact_details",
              "inconsistency",
              "other",
            ]),
            severity: z.enum(["info", "warn", "block"]),
            excerpt: text,
            note: text,
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const structuredOutputSchemas = {
  StoryPlan: storyPlanSchema,
  StoryText: storyTextSchema,
  SceneList: sceneListSchema,
  PagePrompt: pagePromptSchema,
  ReviewFindings: reviewFindingsSchema,
} as const;

export function providerJsonSchema(schemaIdInput: StructuredSchemaId): object {
  const schemaId = structuredSchemaIdSchema.parse(schemaIdInput);
  return z.toJSONSchema(structuredOutputSchemas[schemaId]);
}

export type StructuredParseResult =
  { ok: true; value: unknown } | { ok: false; failure: NormalizedFailure };

export function parseStructuredOutput(
  schemaIdInput: StructuredSchemaId,
  raw: string,
  taskInput: GenerationTaskV1,
): StructuredParseResult {
  const schemaId = structuredSchemaIdSchema.parse(schemaIdInput);
  const taskResult = generationTaskV1Schema.safeParse(taskInput);
  if (!taskResult.success || taskResult.data.schemaId !== schemaId) {
    return invalidResult(raw, "output_validation_failed", [
      { path: ["task", "schemaId"], code: "schema_task_mismatch" },
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return invalidResult(raw, "malformed_output");
  }
  const schemaResult = structuredOutputSchemas[schemaId].safeParse(parsed);
  if (!schemaResult.success) {
    return invalidResult(
      raw,
      "output_validation_failed",
      schemaResult.error.issues,
    );
  }
  const crossIssues = crossCheck(schemaId, schemaResult.data, taskResult.data);
  if (crossIssues.length > 0) {
    return invalidResult(raw, "output_validation_failed", crossIssues);
  }
  return { ok: true, value: schemaResult.data };
}

function crossCheck(
  schemaId: StructuredSchemaId,
  value: unknown,
  task: GenerationTaskV1,
): StructuralIssue[] {
  switch (schemaId) {
    case "StoryPlan":
      return checkStoryPlan(storyPlanSchema.parse(value), task);
    case "StoryText":
      return checkStoryText(storyTextSchema.parse(value), task);
    case "SceneList":
      return checkSceneList(sceneListSchema.parse(value), task);
    case "PagePrompt":
      return checkPagePrompt(pagePromptSchema.parse(value), task);
    case "ReviewFindings":
      return checkReviewFindings(reviewFindingsSchema.parse(value), task);
  }
}

function checkStoryPlan(
  value: z.infer<typeof storyPlanSchema>,
  task: GenerationTaskV1,
): StructuralIssue[] {
  if (task.schemaId !== "StoryPlan") return mismatch();
  const issues: StructuralIssue[] = [];
  const estimated = value.arc.reduce(
    (sum, item) => sum + item.pagesEstimate,
    0,
  );
  if (value.pageBudget.storyPages !== task.payload.pageCount) {
    issues.push(issue("pageBudget.storyPages", "page_count_mismatch"));
  }
  if (estimated !== task.payload.pageCount) {
    issues.push(issue("arc", "page_estimate_sum_mismatch"));
  }
  checkMemberRefs(
    value.characterArcs.map((item) => item.characterRef),
    task,
    issues,
  );
  if (
    !sameRefSet(
      task.participants.map((item) => item.characterRef),
      value.characterArcs.map((item) => item.characterRef),
    )
  ) {
    issues.push(issue("characterArcs", "participant_set_mismatch"));
  }
  return issues;
}

function checkStoryText(
  value: z.infer<typeof storyTextSchema>,
  task: GenerationTaskV1,
): StructuralIssue[] {
  if (task.schemaId !== "StoryText") return mismatch();
  const issues = checkOrderedPages(
    value.pages.map((page) => page.pageNumber),
    task.payload.pageCount,
  );
  const speakers = value.pages.flatMap((page) =>
    page.dialogue.map((line) => line.speaker),
  );
  checkMemberRefs(speakers, task, issues);
  value.pages.forEach((page, index) => {
    const words = page.narrative.split(/\s+/u).filter(Boolean).length;
    const minimum = Math.floor(task.payload.wordsPerPage.minimum * 0.8);
    const maximum = Math.ceil(task.payload.wordsPerPage.maximum * 1.2);
    if (words < minimum || words > maximum) {
      issues.push(issue(`pages.${index}.narrative`, "word_budget_mismatch"));
    }
  });
  return issues;
}

function checkSceneList(
  value: z.infer<typeof sceneListSchema>,
  task: GenerationTaskV1,
): StructuralIssue[] {
  if (task.schemaId !== "SceneList") return mismatch();
  const issues = checkOrderedPages(
    value.scenes.map((scene) => scene.pageNumber),
    task.payload.pageCount,
  );
  value.scenes.forEach((scene, sceneIndex) => {
    checkMemberRefs(scene.participants, task, issues, `scenes.${sceneIndex}`);
    checkMemberRefs(
      scene.perCharacter.map((item) => item.characterRef),
      task,
      issues,
      `scenes.${sceneIndex}.perCharacter`,
    );
    if (
      !sameRefSet(
        scene.participants,
        scene.perCharacter.map((item) => item.characterRef),
      )
    ) {
      issues.push(
        issue(`scenes.${sceneIndex}.perCharacter`, "participant_set_mismatch"),
      );
    }
    scene.perCharacter.forEach((item, itemIndex) => {
      const participant = findParticipant(task, item.characterRef);
      if (item.lookId && !participant?.availableLookIds.includes(item.lookId)) {
        issues.push(
          issue(
            `scenes.${sceneIndex}.perCharacter.${itemIndex}.lookId`,
            "foreign_look",
          ),
        );
      }
    });
  });
  return issues;
}

function checkPagePrompt(
  value: z.infer<typeof pagePromptSchema>,
  task: GenerationTaskV1,
): StructuralIssue[] {
  if (task.schemaId !== "PagePrompt") return mismatch();
  const issues: StructuralIssue[] = [];
  if (value.pageNumber !== task.payload.pageNumber) {
    issues.push(issue("pageNumber", "page_number_mismatch"));
  }
  const outputRefs = value.referencePlan.map((item) => item.characterRef);
  if (!sameRefSet(task.payload.scene.participantRefs, outputRefs)) {
    issues.push(issue("referencePlan", "participant_set_mismatch"));
  }
  checkMemberRefs(outputRefs, task, issues, "referencePlan");
  for (const required of MANDATORY_NEGATIVE_CONSTRAINTS) {
    if (!value.negativeConstraints.includes(required)) {
      issues.push(issue("negativeConstraints", `missing_${required}`));
    }
  }
  if (value.prompt.includes(task.payload.narrativeText)) {
    issues.push(issue("prompt", "narrative_embedded"));
  }
  if (
    checkPromptPolicy(value.prompt, task.payload.styleId).status !== "allowed"
  ) {
    issues.push(issue("prompt", "prompt_policy_confirmation_required"));
  }
  return issues;
}

function checkReviewFindings(
  value: z.infer<typeof reviewFindingsSchema>,
  task: GenerationTaskV1,
): StructuralIssue[] {
  if (task.schemaId !== "ReviewFindings") return mismatch();
  const issues: StructuralIssue[] = [];
  value.findings.forEach((finding, index) => {
    if (finding.pageNumber && finding.pageNumber > task.payload.pageCount) {
      issues.push(
        issue(`findings.${index}.pageNumber`, "page_number_mismatch"),
      );
    }
    if (!task.payload.artifactRefs.includes(finding.refId)) {
      issues.push(issue(`findings.${index}.refId`, "foreign_artifact_ref"));
    }
  });
  return issues;
}

function checkOrderedPages(
  pageNumbers: number[],
  expected: number,
): StructuralIssue[] {
  if (
    pageNumbers.length !== expected ||
    pageNumbers.some((page, index) => page !== index + 1)
  ) {
    return [issue("pages", "page_sequence_mismatch")];
  }
  return [];
}

function checkMemberRefs(
  refs: CharacterRef[],
  task: GenerationTaskV1,
  issues: StructuralIssue[],
  path = "characterRef",
): void {
  const allowed = new Set(
    task.participants.map((item) => refKey(item.characterRef)),
  );
  refs.forEach((ref, index) => {
    if (!allowed.has(refKey(ref))) {
      issues.push(issue(`${path}.${index}`, "alien_character"));
    }
  });
}

function sameRefSet(left: CharacterRef[], right: CharacterRef[]): boolean {
  const leftKeys = [...new Set(left.map(refKey))].sort();
  const rightKeys = [...new Set(right.map(refKey))].sort();
  return JSON.stringify(leftKeys) === JSON.stringify(rightKeys);
}

function findParticipant(task: GenerationTaskV1, ref: CharacterRef) {
  return task.participants.find(
    (item) => refKey(item.characterRef) === refKey(ref),
  );
}

function refKey(ref: CharacterRef): string {
  return `${ref.characterId}:${ref.characterVersionId}`;
}

function mismatch(): StructuralIssue[] {
  return [issue("task.schemaId", "schema_task_mismatch")];
}

function issue(path: string, code: string): StructuralIssue {
  return { path: path.split("."), code };
}

function invalidResult(
  raw: string,
  category: "malformed_output" | "output_validation_failed",
  issues: readonly StructuralIssue[] = [],
): StructuredParseResult {
  const diagnostics = structuralDiagnostics(raw, issues);
  return {
    ok: false,
    failure: makeFailure(category, {
      providerDetail: JSON.stringify(diagnostics),
    }),
  };
}
