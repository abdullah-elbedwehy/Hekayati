import { createHash } from "node:crypto";

import { providerIdSchema, type ProviderId } from "../contract.js";
import { makeFailure, type NormalizedFailure } from "../failures.js";
import {
  checkPromptPolicy,
  confirmationMatches,
  type PromptPolicyConfirmation,
} from "./policy.js";
import { styleConfig, styleIdSchema, type StyleId } from "./styles.js";

export { MANDATORY_NEGATIVE_CONSTRAINTS } from "./styles.js";

export type PromptCompilation =
  | {
      ok: true;
      prompt: string;
      promptHash: string;
      promptVersion: string;
      policyVersion: string;
      transformed: boolean;
      negativeConstraints: readonly string[];
    }
  | { ok: false; failure: NormalizedFailure };

export function compileProviderPrompt(input: {
  provider: ProviderId;
  prompt: string;
  styleId: StyleId;
  confirmation?: PromptPolicyConfirmation;
}): PromptCompilation {
  const provider = providerIdSchema.parse(input.provider);
  const style = styleConfig(styleIdSchema.parse(input.styleId));
  const check = checkPromptPolicy(input.prompt, style.id);
  if (
    check.status === "confirmation_required" &&
    !confirmationMatches(check, input.confirmation)
  ) {
    return { ok: false, failure: makeFailure("invalid_input") };
  }
  const creativePrompt =
    check.status === "confirmation_required"
      ? check.alternativePrompt
      : check.originalPrompt;
  const prompt = providerEnvelope(provider, [
    creativePrompt,
    style.directive,
    style.palette,
    style.composition,
    `قيود إلزامية: ${style.negativeConstraints.join(", ")}.`,
  ]);
  return {
    ok: true,
    prompt,
    promptHash: createHash("sha256").update(prompt).digest("hex"),
    promptVersion: `hekayati-${style.id}-v${style.version}`,
    policyVersion: check.policyVersion,
    transformed: check.status === "confirmation_required",
    negativeConstraints: style.negativeConstraints,
  };
}

function providerEnvelope(provider: ProviderId, parts: string[]): string {
  const label =
    provider === "gemini"
      ? "GEMINI_HEKAYATI_V1"
      : provider === "codex"
        ? "CODEX_HEKAYATI_V1"
        : "MOCK_HEKAYATI_V1";
  return [`[${label}]`, ...parts].join("\n");
}
