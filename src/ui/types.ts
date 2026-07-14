export interface Settings {
  id: "operator";
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  textProvider: "mock" | "codex" | "gemini";
  imageProvider: "mock" | "codex" | "gemini";
  models: {
    codexText: string;
    geminiText: string;
    geminiImage: string;
    geminiImageEconomy: string;
  };
  concurrencyPerProvider: number;
  typography: { minimumAge3To5Pt: number; minimumAge6PlusPt: number };
  watermarkText: string;
  diskWarnGb: number;
  storagePathsReadonly: { data: string; assets: string };
  firstRunAcknowledged: boolean;
  deferredStatus: {
    providerLifecycle: "not_configured";
    printerProfiles: "not_configured";
  };
}

export type SettingsUpdate = Pick<
  Settings,
  | "textProvider"
  | "imageProvider"
  | "models"
  | "concurrencyPerProvider"
  | "typography"
  | "watermarkText"
  | "diskWarnGb"
  | "firstRunAcknowledged"
>;

export interface IntegrityReport {
  checked: number;
  healthy: number;
  issues: Array<{ assetId: string; reason: "missing" | "checksum_mismatch" }>;
  scannedAt: string;
}

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
