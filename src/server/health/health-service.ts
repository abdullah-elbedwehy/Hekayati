import { statfs } from "node:fs/promises";

import type { AssetStore, IntegrityReport } from "../../assets/asset-store.js";
import { DEFAULT_DISK_WARNING_GB } from "../../config/defaults.js";
import type { DataPaths } from "../../config/paths.js";
import type { DocumentStore } from "../../domain/repository/document-store.js";
import type { SettingsService } from "../../domain/settings/settings.js";
import type { LocalRequestBoundary } from "../security/request-boundary.js";

const GIB = 1024 ** 3;

export interface HealthSnapshot {
  checkedAt: string;
  database: { status: "ok" | "error" };
  disk: {
    status: "ok" | "warning" | "error";
    freeGb: number | null;
    thresholdGb: number;
  };
  integrity: IntegrityReport;
  listener: { status: "ok" | "error"; canonicalOrigin: string | null };
  providers: { status: "not_configured" };
  queue: { status: "not_available"; depth: null };
  printerProfiles: { status: "not_configured" };
}

export class HealthService {
  private integrity: IntegrityReport;

  constructor(
    private readonly store: DocumentStore,
    private readonly assets: AssetStore,
    private readonly settings: SettingsService,
    private readonly boundary: LocalRequestBoundary,
    private readonly paths: DataPaths,
    initialIntegrity: IntegrityReport,
  ) {
    this.integrity = initialIntegrity;
  }

  async snapshot(): Promise<HealthSnapshot> {
    const database = databaseStatus(this.store);
    const thresholdGb = settingsDiskThreshold(this.settings);
    const disk = await diskStatus(this.paths.root, thresholdGb);
    const listener = this.boundary.status();
    return {
      checkedAt: new Date().toISOString(),
      database,
      disk,
      integrity: this.integrity,
      listener: {
        status: listener.ready && listener.canonicalOrigin ? "ok" : "error",
        canonicalOrigin: listener.canonicalOrigin,
      },
      providers: { status: "not_configured" },
      queue: { status: "not_available", depth: null },
      printerProfiles: { status: "not_configured" },
    };
  }

  async scanIntegrity(): Promise<IntegrityReport> {
    this.integrity = await this.assets.scanIntegrity();
    return this.integrity;
  }
}

function databaseStatus(store: DocumentStore): HealthSnapshot["database"] {
  try {
    return { status: store.isHealthy() ? "ok" : "error" };
  } catch {
    return { status: "error" };
  }
}

function settingsDiskThreshold(settings: SettingsService): number {
  try {
    return settings.get().diskWarnGb;
  } catch {
    return DEFAULT_DISK_WARNING_GB;
  }
}

async function diskStatus(
  path: string,
  thresholdGb: number,
): Promise<HealthSnapshot["disk"]> {
  try {
    const info = await statfs(path);
    const freeGb = Number(((info.bavail * info.bsize) / GIB).toFixed(2));
    return {
      status: freeGb < thresholdGb ? "warning" : "ok",
      freeGb,
      thresholdGb,
    };
  } catch {
    return { status: "error", freeGb: null, thresholdGb };
  }
}
