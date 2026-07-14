import { describe, expect, it, vi } from "vitest";

import {
  runCreativeSmoke,
  type CreativeSmokeReport,
} from "../../scripts/live/creative-smoke.js";

describe("operator-triggered creative live smoke guard", () => {
  it("makes zero call without every explicit cost and G2 gate", async () => {
    const execute = vi.fn<() => Promise<CreativeSmokeReport>>();
    await expect(runCreativeSmoke([], {}, execute)).resolves.toMatchObject({
      status: "SKIP",
      reason: "provider_flag_required",
    });
    await expect(
      runCreativeSmoke(["--provider", "codex", "--execute"], {}, execute),
    ).resolves.toMatchObject({
      status: "SKIP",
      reason: "image_provider_required",
    });
    await expect(
      runCreativeSmoke(["--provider", "gemini"], {}, execute),
    ).resolves.toMatchObject({ status: "SKIP", reason: "dry_run" });
    await expect(
      runCreativeSmoke(["--provider", "gemini", "--execute"], {}, execute),
    ).resolves.toMatchObject({
      status: "SKIP",
      reason: "explicit_confirmation_required",
    });
    await expect(
      runCreativeSmoke(
        ["--provider", "gemini", "--execute"],
        { HEKAYATI_LIVE_PROVIDER_CONFIRM: "I_UNDERSTAND_PROVIDER_COST" },
        execute,
      ),
    ).resolves.toMatchObject({
      status: "SKIP",
      reason: "g2_limits_unverified",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes only exact verified limits to the explicit Gemini executor", async () => {
    const report: CreativeSmokeReport = {
      status: "SKIP",
      provider: "gemini",
      operation: "synthetic_creative_image",
      modelId: "gemini-image-model",
      reason: "not_configured",
      durationMs: 1,
    };
    const execute = vi.fn(() => Promise.resolve(report));
    await expect(
      runCreativeSmoke(
        ["--provider", "gemini", "--execute"],
        {
          HEKAYATI_LIVE_PROVIDER_CONFIRM: "I_UNDERSTAND_PROVIDER_COST",
          HEKAYATI_GEMINI_MAX_REFERENCE_IMAGES: "4",
          HEKAYATI_GEMINI_RELIABLE_CHARACTER_COUNT: "2",
        },
        execute,
      ),
    ).resolves.toEqual(report);
    expect(execute).toHaveBeenCalledWith({
      provider: "gemini",
      maxReferenceImages: 4,
      reliableCharacterCount: 2,
    });
  });
});
