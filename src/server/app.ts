import { existsSync } from "node:fs";
import { join } from "node:path";

import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { ZodError } from "zod";

import { AssetStore } from "../assets/asset-store.js";
import { OriginalAssetStore } from "../assets/original-asset-store.js";
import { PhotoIntakeError } from "../assets/photo-intake/index.js";
import { LOOPBACK_HOST } from "../config/defaults.js";
import {
  prepareDataPaths,
  resolveDataPaths,
  type DataPaths,
} from "../config/paths.js";
import { DocumentStore } from "../domain/repository/document-store.js";
import { AuthoringError, AuthoringService } from "../domain/authoring/index.js";
import { LibraryError } from "../domain/library/errors.js";
import { LibraryService } from "../domain/library/index.js";
import { SettingsService } from "../domain/settings/settings.js";
import { SecuritySentinel } from "../domain/system/sentinel.js";
import {
  createFileLogSink,
  Redactor,
  StructuredLogger,
} from "../security/log.js";
import { SecretPersistenceError } from "../security/secret-registry.js";
import {
  HealthService,
  mergeIntegrityReports,
} from "./health/health-service.js";
import { registerApi } from "./routes/api.js";
import { PhotoReservationError } from "./photo-intake/reservations.js";
import { PhotoIntakeCoordinator } from "./photo-intake/photo-intake-coordinator.js";
import { LocalRequestBoundary } from "./security/request-boundary.js";
import { assertListenerHost, verifyEffectiveAddress } from "./startup/bind.js";
import {
  productionSeedTemplateInstaller,
  type SeedTemplateInstaller,
} from "./startup/seed-templates.js";

export interface RuntimeOptions {
  dataDir?: string;
  serveUi?: boolean;
  uiRoot?: string;
  enableTestRoutes?: boolean;
  seedTemplateInstaller?: SeedTemplateInstaller;
}

export interface StartOptions {
  host?: string;
  port?: number;
}

export interface RuntimeMetrics {
  listenAttempts: number;
  routeDispatches: number;
}

export interface HekayatiRuntime {
  app: FastifyInstance;
  paths: DataPaths;
  metrics: RuntimeMetrics;
  start(options?: StartOptions): Promise<string>;
  close(): Promise<void>;
  sentinelValue(): number;
}

export async function createRuntime(
  options: RuntimeOptions = {},
): Promise<HekayatiRuntime> {
  const paths = resolveDataPaths(options.dataDir);
  await prepareDataPaths(paths);
  return initializeRuntime(options, paths);
}

async function initializeRuntime(
  options: RuntimeOptions,
  paths: DataPaths,
): Promise<HekayatiRuntime> {
  const store = openRuntimeStore(paths.database);
  try {
    await (
      options.seedTemplateInstaller ?? productionSeedTemplateInstaller
    ).install(store);
    const assets = new AssetStore(store, paths.assets);
    const originals = new OriginalAssetStore(store, paths.originals);
    await Promise.all([
      assets.garbageCollectOrphans(),
      originals.garbageCollectOrphans(),
    ]);
    const initialIntegrity = mergeIntegrityReports(
      ...(await Promise.all([
        assets.scanIntegrity(),
        originals.scanIntegrity(),
      ])),
    );
    const settings = new SettingsService(store, paths);
    settings.initialize();
    const library = new LibraryService(store);
    const authoring = new AuthoringService(store, library);
    return await assembleRuntime(
      options,
      paths,
      store,
      assets,
      originals,
      settings,
      library,
      authoring,
      initialIntegrity,
    );
  } catch (error) {
    store.close();
    throw error;
  }
}

async function assembleRuntime(
  options: RuntimeOptions,
  paths: DataPaths,
  store: DocumentStore,
  assets: AssetStore,
  originals: OriginalAssetStore,
  settings: SettingsService,
  library: LibraryService,
  authoring: AuthoringService,
  initialIntegrity: Awaited<ReturnType<AssetStore["scanIntegrity"]>>,
): Promise<HekayatiRuntime> {
  const sentinel = new SecuritySentinel(store);
  const boundary = new LocalRequestBoundary();
  const logger = new StructuredLogger(
    createFileLogSink(join(paths.logs, "app.log")),
    new Redactor(store.secretRegistry),
  );
  const health = new HealthService(
    store,
    assets,
    settings,
    boundary,
    paths,
    initialIntegrity,
    originals,
  );
  const metrics = { listenAttempts: 0, routeDispatches: 0 };
  const photoIntake = new PhotoIntakeCoordinator(
    store,
    assets,
    originals,
    settings,
    library,
  );
  const app = createHttpApp(boundary, metrics, logger);
  await registerMultipart(app);
  registerApi(app, {
    assets,
    settings,
    library,
    authoring,
    photoIntake,
    health,
    boundary,
    sentinel,
    enableTestRoutes: options.enableTestRoutes ?? false,
  });
  await registerUi(app, options);
  return buildRuntime(app, store, boundary, sentinel, paths, metrics, logger);
}

async function registerMultipart(app: FastifyInstance): Promise<void> {
  await app.register(fastifyMultipart, {
    throwFileSizeLimit: true,
    limits: {
      fieldNameSize: 80,
      fieldSize: 64 * 1024,
      fields: 4,
      fileSize: 100 * 1024 * 1024 + 1,
      files: 1,
      headerPairs: 100,
      parts: 5,
    },
  });
}

function openRuntimeStore(database: string): DocumentStore {
  try {
    return new DocumentStore(database);
  } catch (error) {
    if (isSqliteBusy(error))
      throw new Error("DATA_ROOT_IN_USE", { cause: error });
    throw error;
  }
}

function createHttpApp(
  boundary: LocalRequestBoundary,
  metrics: RuntimeMetrics,
  logger: StructuredLogger,
): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: false,
    forceCloseConnections: true,
    bodyLimit: 1024 * 1024,
  });

  app.addHook("onRequest", (request, reply, done) => {
    boundary.guard(request, reply);
    done();
  });
  app.addHook("preHandler", (_request, _reply, done) => {
    metrics.routeDispatches += 1;
    done();
  });
  app.setErrorHandler((error, _request, reply) =>
    handleError(error, reply, logger),
  );
  return app;
}

function buildRuntime(
  app: FastifyInstance,
  store: DocumentStore,
  boundary: LocalRequestBoundary,
  sentinel: SecuritySentinel,
  paths: DataPaths,
  metrics: RuntimeMetrics,
  logger: StructuredLogger,
): HekayatiRuntime {
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    boundary.deactivate();
    try {
      await app.close();
    } finally {
      store.close();
    }
  };
  return {
    app,
    paths,
    metrics,
    sentinelValue: () => sentinel.value(),
    start: async (options = {}) => {
      try {
        const host = options.host ?? LOOPBACK_HOST;
        assertListenerHost(host);
        metrics.listenAttempts += 1;
        await app.listen({ host, port: options.port ?? 0 });
        const address = verifyEffectiveAddress(app.server.address());
        boundary.activate(address.port);
        logger.redactor.register(boundary.bootstrap().csrfToken);
        logger.info("server_ready", {
          canonicalOrigin: boundary.bootstrap().canonicalOrigin,
        });
        return boundary.bootstrap().canonicalOrigin;
      } catch (error) {
        await close();
        throw error;
      }
    },
    close,
  };
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
  );
}

async function registerUi(
  app: FastifyInstance,
  options: RuntimeOptions,
): Promise<void> {
  if (options.serveUi === false) return;
  const root = options.uiRoot ?? join(process.cwd(), "dist", "ui");
  if (!existsSync(join(root, "index.html"))) return;
  await app.register(fastifyStatic, { root, prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/"))
      return reply.code(404).send({ code: "NOT_FOUND" });
    return reply.header("cache-control", "no-store").sendFile("index.html");
  });
}

function handleError(
  error: unknown,
  reply: FastifyReply,
  logger: StructuredLogger,
): void {
  if (error instanceof ZodError) {
    void reply.code(400).send({
      code: "INVALID_INPUT",
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }
  if (error instanceof SecretPersistenceError) {
    void reply.code(400).send({ code: "INVALID_INPUT" });
    return;
  }
  if (error instanceof LibraryError) {
    void reply.code(error.statusCode).send({ code: error.code });
    return;
  }
  if (error instanceof AuthoringError) {
    void reply.code(error.statusCode).send({
      code: error.code,
      details: error.details,
    });
    return;
  }
  if (error instanceof PhotoIntakeError) {
    void reply.code(error.statusCode).send(error.toSafeResponse());
    return;
  }
  if (error instanceof PhotoReservationError) {
    void reply.code(error.statusCode).send({ code: error.code });
    return;
  }
  const status = clientErrorStatus(error);
  if (status !== null) {
    void reply.code(status).send({
      code: status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
    });
    return;
  }
  logger.error("request_failed", {
    error: error instanceof Error ? error : new Error("UNKNOWN_ERROR"),
  });
  void reply.code(500).send({ code: "INTERNAL_ERROR" });
}

function clientErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("statusCode" in error))
    return null;
  const status = error.statusCode;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : null;
}
