import type { SettingsService } from "../settings/settings.js";
import { createJobTarget } from "../../jobs/targets.js";
import { failCreative } from "./errors.js";

export function selectedStructuredTarget(settingsService: SettingsService) {
  const settings = settingsService.get();
  const providerId = settings.textProvider;
  const modelId =
    providerId === "mock"
      ? "mock-v1"
      : providerId === "codex"
        ? settings.models.codexText
        : settings.models.geminiText;
  return createJobTarget({
    providerId,
    modelId,
    operation: "structured",
    configuration: {
      schemaVersion: 1,
      storyDialect: "egyptian_arabic",
    },
  });
}

export function selectedImageTarget(settingsService: SettingsService) {
  const settings = settingsService.get();
  const providerId = settings.imageProvider;
  if (providerId === "codex") failCreative("CREATIVE_RUN_STATE_INVALID");
  const modelId =
    providerId === "mock"
      ? "mock-image-v1"
      : settings.geminiImageTier === "economy"
        ? settings.models.geminiImageEconomy
        : settings.models.geminiImage;
  const target = createJobTarget({
    providerId,
    modelId,
    operation: "image",
    configuration: {
      imageTier: providerId === "gemini" ? settings.geminiImageTier : null,
    },
  });
  return { ...target, providerId, operation: "image" as const };
}
