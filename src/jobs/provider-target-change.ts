import type { Settings, SettingsService } from "../domain/settings/settings.js";
import { JobError } from "./errors.js";
import type { JobScheduler } from "./scheduler.js";
import type { JobTarget } from "./schemas.js";
import type { RetargetPreviewEntry } from "./types.js";

export interface ProviderTargetResolver {
  resolve(settings: Settings, operation: JobTarget["operation"]): JobTarget;
}

export interface ProviderTargetAvailability {
  isAvailable(target: JobTarget): boolean;
}

export interface ProviderTargetChangePreview {
  expectedSettingsUpdatedAt: string;
  impactHash: string;
  requiresConfirmation: boolean;
  targets: JobTarget[];
  affected: RetargetPreviewEntry[];
}

export class ProviderTargetChangeError extends Error {
  readonly statusCode = 409;

  constructor(
    readonly code:
      | "SETTINGS_TARGET_CHANGE_CONFIRMATION_REQUIRED"
      | "SETTINGS_TARGET_CHANGE_STALE",
  ) {
    super(code);
    this.name = "ProviderTargetChangeError";
  }
}

export class ProviderTargetChangeCoordinator {
  constructor(
    private readonly settings: SettingsService,
    private readonly scheduler: JobScheduler,
    private readonly resolver: ProviderTargetResolver,
    private readonly availability: ProviderTargetAvailability,
  ) {}

  preview(update: unknown): ProviderTargetChangePreview {
    const current = this.settings.get();
    const next = this.settings.preview(update);
    const targets = changedTargets(current, next, this.resolver, (operation) =>
      this.scheduler.hasRetargetableOperation(operation),
    );
    const impact = this.scheduler.previewRetarget(targets);
    return {
      expectedSettingsUpdatedAt: current.updatedAt,
      impactHash: impact.impactHash,
      requiresConfirmation: impact.affected.length > 0,
      targets,
      affected: impact.affected,
    };
  }

  save(update: unknown): Settings {
    if (this.preview(update).requiresConfirmation)
      throw new ProviderTargetChangeError(
        "SETTINGS_TARGET_CHANGE_CONFIRMATION_REQUIRED",
      );
    return this.settings.update(update);
  }

  confirm(input: {
    update: unknown;
    expectedSettingsUpdatedAt: string;
    impactHash: string;
  }): { settings: Settings; successorJobIds: string[] } {
    const preview = this.preview(input.update);
    assertPreviewCurrent(preview, input);
    if (!preview.requiresConfirmation)
      return {
        settings: this.settings.update(input.update),
        successorJobIds: [],
      };
    const result = this.scheduler.retargetRemaining(
      {
        targets: preview.targets,
        expectedImpactHash: input.impactHash,
        expectedSettingsUpdatedAt: input.expectedSettingsUpdatedAt,
        isTargetAvailable: (target) => this.availability.isAvailable(target),
      },
      () => {
        if (this.settings.get().updatedAt !== input.expectedSettingsUpdatedAt)
          throw new ProviderTargetChangeError("SETTINGS_TARGET_CHANGE_STALE");
        return this.settings.update(input.update);
      },
    );
    return {
      settings: result.settings,
      successorJobIds: result.successors.map((job) => job.id),
    };
  }
}

function changedTargets(
  current: Settings,
  next: Settings,
  resolver: ProviderTargetResolver,
  hasWork: (operation: JobTarget["operation"]) => boolean,
): JobTarget[] {
  const operations: JobTarget["operation"][] = ["text", "structured", "image"];
  return operations.flatMap((operation) => {
    if (!hasWork(operation) || !selectionChanged(current, next, operation))
      return [];
    return [resolver.resolve(next, operation)];
  });
}

function selectionChanged(
  current: Settings,
  next: Settings,
  operation: JobTarget["operation"],
): boolean {
  if (operation === "image")
    return imageSelection(current) !== imageSelection(next);
  return textSelection(current) !== textSelection(next);
}

function textSelection(settings: Settings): string {
  const provider = settings.textProvider;
  const model =
    provider === "codex"
      ? settings.models.codexText
      : provider === "gemini"
        ? settings.models.geminiText
        : "mock";
  return `${provider}:${model}`;
}

function imageSelection(settings: Settings): string {
  const provider = settings.imageProvider;
  const model =
    provider === "gemini"
      ? settings.geminiImageTier === "economy"
        ? settings.models.geminiImageEconomy
        : settings.models.geminiImage
      : provider;
  return `${provider}:${model}:${provider === "gemini" ? settings.geminiImageTier : "default"}`;
}

function assertPreviewCurrent(
  preview: ProviderTargetChangePreview,
  input: { expectedSettingsUpdatedAt: string; impactHash: string },
): void {
  if (
    preview.expectedSettingsUpdatedAt !== input.expectedSettingsUpdatedAt ||
    preview.impactHash !== input.impactHash
  )
    throw new ProviderTargetChangeError("SETTINGS_TARGET_CHANGE_STALE");
  if (preview.targets.length === 0 && preview.requiresConfirmation)
    throw new JobError("JOB_TARGET_CHANGE_INVALID");
}
