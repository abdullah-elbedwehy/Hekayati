import { describe, expect, it, vi } from "vitest";

import {
  runSmoke,
  type SmokeReport,
} from "../../scripts/live/provider-smoke.js";

describe("operator-triggered provider smoke guard", () => {
  it("makes zero call without a provider, execute flag, or confirmation", async () => {
    const execute = vi.fn<() => Promise<SmokeReport>>();
    await expect(runSmoke([], {}, execute)).resolves.toMatchObject({
      status: "SKIP",
      reason: "provider_flag_required",
    });
    await expect(
      runSmoke(["--provider", "gemini"], {}, execute),
    ).resolves.toMatchObject({ status: "SKIP", reason: "dry_run" });
    await expect(
      runSmoke(["--provider", "codex", "--execute"], {}, execute),
    ).resolves.toMatchObject({
      status: "SKIP",
      reason: "explicit_confirmation_required",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes only the explicit provider and separate image-cost intent", async () => {
    const report: SmokeReport = {
      status: "SKIP",
      provider: "gemini",
      operation: "structured_and_image_probe",
      reason: "not_configured",
      durationMs: 1,
    };
    const execute = vi.fn(() => Promise.resolve(report));
    await expect(
      runSmoke(
        ["--provider", "gemini", "--execute", "--image"],
        {
          HEKAYATI_LIVE_PROVIDER_CONFIRM: "I_UNDERSTAND_PROVIDER_COST",
        },
        execute,
      ),
    ).resolves.toEqual(report);
    expect(execute).toHaveBeenCalledWith({
      provider: "gemini",
      includeImage: true,
    });
  });
});
