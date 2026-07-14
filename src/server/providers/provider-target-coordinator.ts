import type {
  Settings,
  SettingsService,
} from "../../domain/settings/settings.js";
import { JobError } from "../../jobs/errors.js";
import { ProviderTargetChangeCoordinator } from "../../jobs/provider-target-change.js";
import type { JobRuntime } from "../../jobs/runtime.js";
import type { JobTarget } from "../../jobs/schemas.js";
import { createJobTarget, sameJobTarget } from "../../jobs/targets.js";
import type { ProviderService } from "./provider-service.js";

export function createProviderTargetChangeCoordinator(
  settings: SettingsService,
  jobs: JobRuntime,
  providers: ProviderService,
): ProviderTargetChangeCoordinator {
  return new ProviderTargetChangeCoordinator(
    settings,
    jobs.scheduler,
    {
      resolve: (candidate, operation) =>
        resolveTarget(candidate, operation, providers),
    },
    {
      isAvailable: (target) =>
        cachedTargets(settings.get(), target.operation, providers).some(
          (candidate) => sameJobTarget(candidate, target),
        ),
    },
  );
}

function resolveTarget(
  settings: Settings,
  operation: JobTarget["operation"],
  providers: ProviderService,
): JobTarget {
  const providerId = selectedProvider(settings, operation);
  const cached = providers
    .cachedAvailableTargets(operation)
    .find((target) => target.providerId === providerId);
  const modelId = cached?.modelId ?? configuredModel(settings, operation);
  if (!modelId) throw new JobError("SETTINGS_TARGET_UNRESOLVED", 409);
  return createJobTarget({
    providerId,
    modelId,
    operation,
    configuration: targetConfiguration(settings, providerId, operation),
  });
}

function cachedTargets(
  settings: Settings,
  operation: JobTarget["operation"],
  providers: ProviderService,
): JobTarget[] {
  return providers.cachedAvailableTargets(operation).map((target) =>
    createJobTarget({
      ...target,
      configuration: targetConfiguration(
        settings,
        target.providerId,
        operation,
      ),
    }),
  );
}

function selectedProvider(
  settings: Settings,
  operation: JobTarget["operation"],
): JobTarget["providerId"] {
  return operation === "image" ? settings.imageProvider : settings.textProvider;
}

function configuredModel(
  settings: Settings,
  operation: JobTarget["operation"],
): string | null {
  const provider = selectedProvider(settings, operation);
  if (operation === "image") {
    if (provider !== "gemini") return null;
    return settings.geminiImageTier === "economy"
      ? settings.models.geminiImageEconomy
      : settings.models.geminiImage;
  }
  if (provider === "codex") return settings.models.codexText;
  if (provider === "gemini") return settings.models.geminiText;
  return null;
}

function targetConfiguration(
  settings: Settings,
  providerId: JobTarget["providerId"],
  operation: JobTarget["operation"],
) {
  return {
    imageTier:
      providerId === "gemini" && operation === "image"
        ? settings.geminiImageTier
        : null,
  };
}
