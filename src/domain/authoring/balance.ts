import type { PageCount, StoryConfig, StoryType } from "./schemas.js";

export interface BalanceDrivers {
  audienceAgeBand: StoryConfig["audienceAgeBand"];
  readingLevel: StoryConfig["readingLevel"];
  storyType: StoryType;
  pageCount: PageCount;
  sceneComplexity: StoryConfig["sceneComplexity"];
}

export interface ExistingBalanceChoice {
  selectedNarrationPercent: number;
  operatorEdited: boolean;
}

export function calculateNarrationBalance(
  drivers: BalanceDrivers,
  existing?: ExistingBalanceChoice,
): StoryConfig["narrationDialogueBalance"] {
  const suggestedNarrationPercent = clamp(
    ageBase(drivers.audienceAgeBand) +
      readingDelta(drivers.readingLevel) +
      storyDelta(drivers.storyType) +
      (drivers.pageCount === 24 ? -5 : 0) +
      complexityDelta(drivers.sceneComplexity),
    40,
    85,
  );
  const operatorEdited = existing?.operatorEdited ?? false;
  return {
    suggestedNarrationPercent,
    selectedNarrationPercent: operatorEdited
      ? clamp(
          existing?.selectedNarrationPercent ?? suggestedNarrationPercent,
          0,
          100,
        )
      : suggestedNarrationPercent,
    operatorEdited,
    formulaVersion: "hekayati.balance.v1",
  };
}

function ageBase(age: BalanceDrivers["audienceAgeBand"]): number {
  if (age === "age_3_5") return 75;
  if (age === "age_6_8") return 65;
  return 55;
}

function readingDelta(level: BalanceDrivers["readingLevel"]): number {
  if (level === "early") return 10;
  if (level === "independent") return -10;
  return 0;
}

function storyDelta(type: StoryType): number {
  if (type === "related_situations") return 5;
  if (type === "connected_adventure") return -5;
  return 0;
}

function complexityDelta(
  complexity: BalanceDrivers["sceneComplexity"],
): number {
  if (complexity === "low") return -5;
  if (complexity === "high") return 10;
  return 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
