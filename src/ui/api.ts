import type {
  HealthSnapshot,
  IntegrityReport,
  Settings,
  SettingsUpdate,
} from "./types";

interface BootstrapResponse {
  appName: string;
  direction: "rtl";
  canonicalOrigin: string;
  csrfToken: string;
}

export class ApiError extends Error {
  constructor(readonly category: "stale_session" | "request_failed") {
    super(category === "stale_session" ? "STALE_SESSION" : "REQUEST_FAILED");
  }
}

export class ApiClient {
  private constructor(private readonly csrfToken: string) {}

  static async connect(): Promise<ApiClient> {
    const response = await fetch("/api/bootstrap", { cache: "no-store" });
    if (!response.ok) throw new ApiError("request_failed");
    const bootstrap = (await response.json()) as BootstrapResponse;
    if (bootstrap.canonicalOrigin !== window.location.origin)
      throw new ApiError("request_failed");
    return new ApiClient(bootstrap.csrfToken);
  }

  settings(): Promise<Settings> {
    return this.request("/api/settings");
  }

  updateSettings(update: SettingsUpdate): Promise<Settings> {
    return this.request("/api/settings", {
      method: "PUT",
      body: JSON.stringify(update),
    });
  }

  health(): Promise<HealthSnapshot> {
    return this.request("/api/health");
  }

  scanIntegrity(): Promise<IntegrityReport> {
    return this.request("/api/health/integrity-scan", { method: "POST" });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const unsafe =
      init.method !== undefined && !["GET", "HEAD"].includes(init.method);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    if (unsafe) headers.set("x-hekayati-csrf", this.csrfToken);
    const response = await fetch(path, { ...init, headers, cache: "no-store" });
    if (response.status === 403) throw new ApiError("stale_session");
    if (!response.ok) throw new ApiError("request_failed");
    return (await response.json()) as T;
  }
}

export function toSettingsUpdate(settings: Settings): SettingsUpdate {
  const {
    textProvider,
    imageProvider,
    models,
    concurrencyPerProvider,
    typography,
    watermarkText,
    diskWarnGb,
    firstRunAcknowledged,
  } = settings;
  return {
    textProvider,
    imageProvider,
    models,
    concurrencyPerProvider,
    typography,
    watermarkText,
    diskWarnGb,
    firstRunAcknowledged,
  };
}
