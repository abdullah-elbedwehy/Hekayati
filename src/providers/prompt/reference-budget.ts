import { allocateReferenceBudget as allocateNeutralReferenceBudget } from "../../contracts/reference-budget.js";
import { makeFailure, type NormalizedFailure } from "../failures.js";

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
  const result = allocateNeutralReferenceBudget(input);
  if (result.ok) return result;
  if (result.reason === "unverified_limits") {
    return {
      ok: false,
      failure: makeFailure("provider_unavailable", {
        message: "حدود مراجع الصور لم تُقَس بعد.",
      }),
    };
  }
  return { ok: false, failure: makeFailure("invalid_input") };
}
