import type { z } from "zod";

import type {
  pagePromptSchema,
  reviewFindingsSchema,
  sceneListSchema,
  storyPlanSchema,
  storyTextSchema,
} from "../../contracts/creative-outputs.js";

export type StoryPlan = z.infer<typeof storyPlanSchema>;
export type StoryText = z.infer<typeof storyTextSchema>;
export type SceneList = z.infer<typeof sceneListSchema>;
export type PagePrompt = z.infer<typeof pagePromptSchema>;
export type ReviewFindings = z.infer<typeof reviewFindingsSchema>;
