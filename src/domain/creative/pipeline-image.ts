import type { ProjectWorkspace } from "../authoring/index.js";
import type { LibraryService } from "../library/index.js";
import { neutralImageRequestDraftSchema } from "../../contracts/creative-generation.js";
import type { CreativeCapacityPlan } from "../../contracts/creative-policy.js";
import type { PagePrompt, SceneList } from "./output-types.js";
import { compiledImageScene } from "./generation-context.js";
import { failCreative } from "./errors.js";
import type { CharacterSheet } from "./schemas.js";

export function approvedSheetsForWorkspace(
  workspace: ProjectWorkspace,
  sheets: readonly CharacterSheet[],
  library: LibraryService,
): CharacterSheet[] {
  return workspace.version.storyConfig.participants.map((participant) => {
    const candidates = sheets
      .filter(
        (sheet) =>
          sheet.projectId === workspace.project.id &&
          sheet.characterId === participant.characterId &&
          sheet.characterVersionId === participant.characterVersionId &&
          sheet.status === "approved" &&
          appearanceMatches(participant.appearance, sheet),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const selected = candidates[0];
    if (!selected) failCreative("CREATIVE_SHEET_NOT_APPROVED");
    if (selected.referenceLineage.source === "photo_derived")
      library.assertPhotoConsent(selected.customerId, "photo_derived_sheet");
    return selected;
  });
}

export function buildPageImageDraft(input: {
  workspace: ProjectWorkspace;
  sceneList: SceneList;
  prompt: PagePrompt;
  approvedSheets: readonly CharacterSheet[];
  capacityPlan: CreativeCapacityPlan;
}) {
  const pageCharacterIds = new Set(
    input.prompt.referencePlan.map((plan) => plan.characterRef.characterId),
  );
  const references = input.capacityPlan.participants
    .filter((plan) => pageCharacterIds.has(plan.characterId))
    .flatMap((plan) => {
      const sheet = input.approvedSheets.find(
        (candidate) => candidate.characterId === plan.characterId,
      );
      if (!sheet) failCreative("CREATIVE_SHEET_NOT_APPROVED");
      return plan.selectedAssetIds.map((assetId) => {
        if (!Object.values(sheet.views).includes(assetId))
          failCreative("CREATIVE_SHEET_REFERENCE_MISMATCH");
        return {
          source: "approved_character_sheet" as const,
          characterSheetId: sheet.id,
          customerId: sheet.customerId,
          familyId: sheet.familyId,
          characterId: sheet.characterId,
          characterVersionId: sheet.characterVersionId,
          appearance: sheet.appearance,
          sheetAssetId: assetId,
        };
      });
    });
  const scene = compiledImageScene(input.sceneList, input.prompt.pageNumber);
  return neutralImageRequestDraftSchema.parse({
    styleId: input.workspace.version.storyConfig.illustrationStyleId,
    capacityPlan: input.capacityPlan,
    scene: { ...scene, description: input.prompt.prompt },
    referenceImages: references,
    negativeConstraints: input.prompt.negativeConstraints,
    output: { minWidthPx: 2480, minHeightPx: 3508 },
  });
}

function appearanceMatches(
  appearance: ProjectWorkspace["version"]["storyConfig"]["participants"][number]["appearance"],
  sheet: CharacterSheet,
): boolean {
  if (appearance.type === "base") return sheet.appearance.type === "base";
  if (appearance.type === "shared_look") {
    return (
      sheet.appearance.type === "shared_look" &&
      sheet.appearance.lookId === appearance.lookId &&
      sheet.appearance.lookVersionId === appearance.lookVersionId
    );
  }
  return true;
}
