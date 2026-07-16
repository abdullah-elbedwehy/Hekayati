import { z } from "zod";
import { ulid } from "ulid";

import {
  DEFAULT_DISK_WARNING_GB,
  DEFAULT_MODELS,
  DEFAULT_PHOTO_MAX_MEGAPIXELS,
  DEFAULT_PHOTO_UPLOAD_MAX_MB,
} from "../../config/defaults.js";
import type { DataPaths } from "../../config/paths.js";
import {
  DocumentRepository,
  type DocumentStore,
} from "../repository/document-store.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { CreativeInvalidationService } from "../creative/invalidation.js";

const providerStatusSchema = z.enum([
  "not_configured",
  "not_available",
  "available",
]);

export const settingsSchema = z
  .object({
    id: z.literal("operator"),
    schemaVersion: z.literal(4),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    textProvider: z.enum(["mock", "codex", "gemini"]),
    imageProvider: z.enum(["mock", "codex", "gemini"]),
    geminiImageTier: z.enum(["default", "economy"]),
    models: z
      .object({
        codexText: z.string().trim().min(1).max(120),
        geminiText: z.string().trim().min(1).max(120),
        geminiImage: z.string().trim().min(1).max(120),
        geminiImageEconomy: z.string().trim().min(1).max(120),
      })
      .strict(),
    concurrencyPerProvider: z.number().int().min(1).max(4),
    typography: z
      .object({
        minimumAge3To5Pt: z.number().int().min(14).max(36),
        minimumAge6PlusPt: z.number().int().min(12).max(36),
      })
      .strict(),
    watermarkText: z.string().trim().min(1).max(80),
    diskWarnGb: z.number().min(1).max(1000),
    photoUploadMaxMb: z.number().int().min(1).max(100),
    photoMaxMegapixels: z.number().int().min(1).max(200),
    storagePathsReadonly: z
      .object({ data: z.string().min(1), assets: z.string().min(1) })
      .strict(),
    firstRunAcknowledged: z.boolean(),
    deferredStatus: z
      .object({
        providerLifecycle: providerStatusSchema,
        printerProfiles: providerStatusSchema,
      })
      .strict(),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;

export const settingsUpdateSchema = settingsSchema
  .pick({
    textProvider: true,
    imageProvider: true,
    geminiImageTier: true,
    models: true,
    concurrencyPerProvider: true,
    typography: true,
    watermarkText: true,
    diskWarnGb: true,
    photoUploadMaxMb: true,
    photoMaxMegapixels: true,
    firstRunAcknowledged: true,
  })
  .partial({ photoUploadMaxMb: true, photoMaxMegapixels: true })
  .strict();

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export class SettingsService {
  private readonly repository: DocumentRepository<Settings>;
  private invalidation: CreativeInvalidationService | null = null;

  constructor(
    private readonly store: DocumentStore,
    private readonly paths: DataPaths,
  ) {
    this.repository = new DocumentRepository(store, "settings", settingsSchema);
  }

  bindInvalidation(invalidation: CreativeInvalidationService): void {
    if (this.invalidation && this.invalidation !== invalidation)
      throw new Error("SETTINGS_INVALIDATION_CONFLICT");
    this.invalidation = invalidation;
  }

  initialize(): Settings {
    this.store.migrateDocuments("settings", 4, settingsSchema, [
      {
        from: 1,
        to: 2,
        migrate: migrateSettingsV1ToV2,
      },
      {
        from: 2,
        to: 3,
        migrate: migrateSettingsV2ToV3,
      },
      {
        from: 3,
        to: 4,
        migrate: migrateSettingsV3ToV4,
      },
    ]);
    const existing = this.repository.get("operator");
    return existing ?? this.repository.put(this.createDefault());
  }

  get(): Settings {
    const settings = this.repository.get("operator");
    if (!settings) throw new Error("SETTINGS_NOT_INITIALIZED");
    return settings;
  }

  update(input: unknown): Settings {
    return this.store.transaction(() => {
      const current = this.get();
      const preview = this.preview(input);
      const at = new Date().toISOString();
      const next = this.repository.put(
        settingsSchema.parse({ ...preview, updatedAt: at }),
      );
      if (current.watermarkText !== next.watermarkText)
        this.emitWatermarkChanges(at);
      return next;
    });
  }

  private emitWatermarkChanges(at: string): void {
    if (!this.invalidation) return;
    const correlationId = ulid();
    for (const project of new AuthoringRepositories(
      this.store,
    ).projects.list()) {
      const eventId = ulid();
      this.invalidation.recordAndConsume({
        id: eventId,
        entity: "watermark_setting",
        entityId: project.id,
        fromVersionId: null,
        toVersionId: null,
        changeType: "watermark_text",
        matrixRow: "IM-19",
        changedFields: ["watermarkText"],
        correlationId,
        occurredAt: at,
      });
    }
  }

  preview(input: unknown): Settings {
    const update = settingsUpdateSchema.parse(input);
    const current = this.get();
    return settingsSchema.parse({
      ...current,
      ...update,
      models: { ...current.models, ...update.models },
      typography: { ...current.typography, ...update.typography },
      storagePathsReadonly: {
        data: this.paths.root,
        assets: this.paths.assets,
      },
      deferredStatus: current.deferredStatus,
      updatedAt: current.updatedAt,
    });
  }

  private createDefault(): Settings {
    const now = new Date().toISOString();
    return settingsSchema.parse({
      id: "operator",
      schemaVersion: 4,
      createdAt: now,
      updatedAt: now,
      textProvider: "mock",
      imageProvider: "mock",
      geminiImageTier: "default",
      models: DEFAULT_MODELS,
      concurrencyPerProvider: 2,
      typography: { minimumAge3To5Pt: 14, minimumAge6PlusPt: 12 },
      watermarkText: "حكايتي — معاينة",
      diskWarnGb: DEFAULT_DISK_WARNING_GB,
      photoUploadMaxMb: DEFAULT_PHOTO_UPLOAD_MAX_MB,
      photoMaxMegapixels: DEFAULT_PHOTO_MAX_MEGAPIXELS,
      storagePathsReadonly: {
        data: this.paths.root,
        assets: this.paths.assets,
      },
      firstRunAcknowledged: false,
      deferredStatus: {
        providerLifecycle: "available",
        printerProfiles: "available",
      },
    });
  }
}

function migrateSettingsV3ToV4(input: unknown): unknown {
  if (!input || typeof input !== "object")
    throw new Error("INVALID_SETTINGS_MIGRATION");
  const record = input as Record<string, unknown>;
  const deferred =
    record.deferredStatus && typeof record.deferredStatus === "object"
      ? (record.deferredStatus as Record<string, unknown>)
      : {};
  return {
    ...record,
    schemaVersion: 4,
    deferredStatus: { ...deferred, printerProfiles: "available" },
  };
}

function migrateSettingsV2ToV3(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    throw new Error("INVALID_SETTINGS_MIGRATION");
  }
  const record = input as Record<string, unknown>;
  const deferred =
    record.deferredStatus && typeof record.deferredStatus === "object"
      ? (record.deferredStatus as Record<string, unknown>)
      : {};
  return {
    ...record,
    schemaVersion: 3,
    geminiImageTier: "default",
    deferredStatus: { ...deferred, providerLifecycle: "available" },
  };
}

function migrateSettingsV1ToV2(input: unknown): unknown {
  if (!input || typeof input !== "object")
    throw new Error("INVALID_SETTINGS_MIGRATION");
  return {
    ...input,
    schemaVersion: 2,
    photoUploadMaxMb: DEFAULT_PHOTO_UPLOAD_MAX_MB,
    photoMaxMegapixels: DEFAULT_PHOTO_MAX_MEGAPIXELS,
  };
}
