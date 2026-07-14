import { z } from "zod";

import {
  DEFAULT_DISK_WARNING_GB,
  DEFAULT_MODELS,
} from "../../config/defaults.js";
import type { DataPaths } from "../../config/paths.js";
import {
  DocumentRepository,
  type DocumentStore,
} from "../repository/document-store.js";

const providerStatusSchema = z.enum([
  "not_configured",
  "not_available",
  "available",
]);

export const settingsSchema = z
  .object({
    id: z.literal("operator"),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    textProvider: z.enum(["mock", "codex", "gemini"]),
    imageProvider: z.enum(["mock", "codex", "gemini"]),
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
    models: true,
    concurrencyPerProvider: true,
    typography: true,
    watermarkText: true,
    diskWarnGb: true,
    firstRunAcknowledged: true,
  })
  .strict();

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export class SettingsService {
  private readonly repository: DocumentRepository<Settings>;

  constructor(
    store: DocumentStore,
    private readonly paths: DataPaths,
  ) {
    this.repository = new DocumentRepository(store, "settings", settingsSchema);
  }

  initialize(): Settings {
    const existing = this.repository.get("operator");
    return existing ?? this.repository.put(this.createDefault());
  }

  get(): Settings {
    const settings = this.repository.get("operator");
    if (!settings) throw new Error("SETTINGS_NOT_INITIALIZED");
    return settings;
  }

  update(input: unknown): Settings {
    const update = settingsUpdateSchema.parse(input);
    const current = this.get();
    return this.repository.put(
      settingsSchema.parse({
        ...current,
        ...update,
        models: { ...current.models, ...update.models },
        typography: { ...current.typography, ...update.typography },
        storagePathsReadonly: {
          data: this.paths.root,
          assets: this.paths.assets,
        },
        deferredStatus: current.deferredStatus,
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  private createDefault(): Settings {
    const now = new Date().toISOString();
    return settingsSchema.parse({
      id: "operator",
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      textProvider: "mock",
      imageProvider: "mock",
      models: DEFAULT_MODELS,
      concurrencyPerProvider: 2,
      typography: { minimumAge3To5Pt: 14, minimumAge6PlusPt: 12 },
      watermarkText: "حكايتي — معاينة",
      diskWarnGb: DEFAULT_DISK_WARNING_GB,
      storagePathsReadonly: {
        data: this.paths.root,
        assets: this.paths.assets,
      },
      firstRunAcknowledged: false,
      deferredStatus: {
        providerLifecycle: "not_configured",
        printerProfiles: "not_configured",
      },
    });
  }
}
