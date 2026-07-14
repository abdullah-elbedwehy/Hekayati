import type { FastifyInstance } from "fastify";

import type { AssetStore } from "../../assets/asset-store.js";
import type { SettingsService } from "../../domain/settings/settings.js";
import type { LibraryService } from "../../domain/library/index.js";
import type { AuthoringService } from "../../domain/authoring/index.js";
import type { SecuritySentinel } from "../../domain/system/sentinel.js";
import type { HealthService } from "../health/health-service.js";
import type { LocalRequestBoundary } from "../security/request-boundary.js";
import type { PhotoIntakeCoordinator } from "../photo-intake/photo-intake-coordinator.js";
import type { ProviderService } from "../providers/provider-service.js";
import type { JobRuntime } from "../../jobs/runtime.js";
import type { ProviderTargetChangeCoordinator } from "../../jobs/provider-target-change.js";
import type { CreativeRuntime } from "../app.js";
import { registerLibraryApi } from "./library-api.js";
import { registerAuthoringApi } from "./authoring-api.js";
import { registerPhotoIntakeApi } from "./photo-intake-api.js";
import { registerProviderApi } from "./provider-api.js";
import { registerJobApi } from "./job-api.js";
import { registerSettingsApi } from "./settings-api.js";
import { registerCreativeApi } from "./creative-api.js";

export interface ApiDependencies {
  assets: AssetStore;
  settings: SettingsService;
  library: LibraryService;
  authoring: AuthoringService;
  photoIntake: PhotoIntakeCoordinator;
  health: HealthService;
  providers: ProviderService;
  jobs: JobRuntime;
  creative: CreativeRuntime;
  targetChanges: ProviderTargetChangeCoordinator;
  boundary: LocalRequestBoundary;
  sentinel: SecuritySentinel;
  enableTestRoutes: boolean;
}

export function registerApi(
  app: FastifyInstance,
  dependencies: ApiDependencies,
): void {
  const { settings, health, boundary, sentinel } = dependencies;

  app.get("/api/bootstrap", (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { appName: "حكايتي", direction: "rtl", ...boundary.bootstrap() };
  });

  registerSettingsApi(app, settings, dependencies.targetChanges);

  app.get("/api/health", () => health.snapshot());

  app.post("/api/health/integrity-scan", () => health.scanIntegrity());

  registerLibraryApi(app, dependencies.library, dependencies.assets);
  registerAuthoringApi(app, dependencies.authoring, dependencies.library);
  registerPhotoIntakeApi(app, dependencies.photoIntake);
  registerProviderApi(app, dependencies.providers);
  registerJobApi(app, dependencies.jobs, dependencies.jobs);
  registerCreativeApi(
    app,
    dependencies.creative,
    dependencies.library,
    dependencies.authoring,
    dependencies.assets,
  );

  if (dependencies.enableTestRoutes) {
    app.get("/api/testing/sentinel", () => ({ value: sentinel.value() }));
    app.post("/api/testing/sentinel", () => ({
      value: sentinel.increment(),
    }));
  }
}
