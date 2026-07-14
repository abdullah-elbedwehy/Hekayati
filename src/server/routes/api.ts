import type { FastifyInstance } from "fastify";

import type { SettingsService } from "../../domain/settings/settings.js";
import type { SecuritySentinel } from "../../domain/system/sentinel.js";
import type { HealthService } from "../health/health-service.js";
import type { LocalRequestBoundary } from "../security/request-boundary.js";

export interface ApiDependencies {
  settings: SettingsService;
  health: HealthService;
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

  app.get("/api/settings", () => settings.get());

  app.put("/api/settings", (request) => settings.update(request.body));

  app.get("/api/health", () => health.snapshot());

  app.post("/api/health/integrity-scan", () => health.scanIntegrity());

  if (dependencies.enableTestRoutes) {
    app.get("/api/testing/sentinel", () => ({ value: sentinel.value() }));
    app.post("/api/testing/sentinel", () => ({
      value: sentinel.increment(),
    }));
  }
}
