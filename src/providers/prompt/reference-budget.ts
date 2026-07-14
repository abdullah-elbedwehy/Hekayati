import { z } from "zod";

import { makeFailure, type NormalizedFailure } from "../failures.js";

const safeId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
  .max(160);

const participantSchema = z
  .object({
    characterId: safeId,
    candidateAssetIds: z.array(safeId).min(1).max(20),
  })
  .strict();

const budgetInputSchema = z
  .object({
    maxReferenceImages: z.number().int().positive().max(100).nullable(),
    reliableCharacterCount: z.number().int().positive().max(20).nullable(),
    participants: z.array(participantSchema).min(1).max(20),
  })
  .strict();

export type ReferenceBudgetResult =
  | {
      ok: true;
      selectedAssetIds: string[];
      counts: Array<{
        characterId: string;
        requested: number;
        selected: number;
      }>;
      reduced: boolean;
      notice: string | null;
    }
  | { ok: false; failure: NormalizedFailure };

export function allocateReferenceBudget(input: unknown): ReferenceBudgetResult {
  const parsed = budgetInputSchema.safeParse(input);
  if (!parsed.success) return invalidBudget();
  const { maxReferenceImages, reliableCharacterCount, participants } =
    parsed.data;
  if (maxReferenceImages === null || reliableCharacterCount === null) {
    return {
      ok: false,
      failure: makeFailure("provider_unavailable", {
        message: "حدود مراجع الصور لم تُقَس بعد.",
      }),
    };
  }
  if (
    !hasUniqueIds(participants) ||
    participants.length > reliableCharacterCount
  ) {
    return invalidBudget();
  }
  if (maxReferenceImages < participants.length) return invalidBudget();
  const selected = selectRoundRobin(participants, maxReferenceImages);
  const counts = participants.map((participant) => ({
    characterId: participant.characterId,
    requested: participant.candidateAssetIds.length,
    selected: selected.filter(
      (item) => item.characterId === participant.characterId,
    ).length,
  }));
  const reduced = counts.some((count) => count.selected < count.requested);
  return {
    ok: true,
    selectedAssetIds: selected.map((item) => item.assetId),
    counts,
    reduced,
    notice: reduced ? "تم تقليل صور المراجع بالتساوي لتناسب حد المزوّد." : null,
  };
}

function selectRoundRobin(
  participants: Array<{ characterId: string; candidateAssetIds: string[] }>,
  limit: number,
): Array<{ characterId: string; assetId: string }> {
  const selected: Array<{ characterId: string; assetId: string }> = [];
  for (let view = 0; selected.length < limit; view += 1) {
    let added = false;
    for (const participant of participants) {
      const assetId = participant.candidateAssetIds[view];
      if (assetId === undefined) continue;
      selected.push({ characterId: participant.characterId, assetId });
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return selected;
}

function hasUniqueIds(
  participants: Array<{ characterId: string; candidateAssetIds: string[] }>,
): boolean {
  const characters = participants.map((item) => item.characterId);
  const assets = participants.flatMap((item) => item.candidateAssetIds);
  return (
    new Set(characters).size === characters.length &&
    new Set(assets).size === assets.length
  );
}

function invalidBudget(): ReferenceBudgetResult {
  return { ok: false, failure: makeFailure("invalid_input") };
}
