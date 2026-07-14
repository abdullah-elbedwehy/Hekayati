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
import {
  CreativeInvalidationService,
  configuredCreativeLimits,
  CreativeError,
  CreativePageService,
  CreativePipelineService,
  CreativeSheetPipeline,
  CreativeSheetService,
} from "../domain/creative/index.js";
import { SecuritySentinel } from "../domain/system/sentinel.js";
import { JobError } from "../jobs/errors.js";
import {
  CredentialAvailabilityBroker,
  ExactCapabilityBroker,
  QuotaAvailabilityBroker,
} from "../jobs/capabilities.js";
import { JobRuntime, type JobRuntimeOptions } from "../jobs/runtime.js";
import { createCreativeJobDefinitions } from "../jobs/creative-definitions.js";
import { createLibraryImageReferenceResolver } from "../jobs/image-references.js";
import { PreDispatchCoordinator } from "../jobs/pre-dispatch.js";
import { ProviderDispatchGateway } from "../jobs/provider-dispatch.js";
import type { QuotaIncident } from "../jobs/schemas.js";
import { createJobTarget } from "../jobs/targets.js";
import type { ProviderTargetChangeCoordinator } from "../jobs/provider-target-change.js";
import { ProviderTargetChangeError } from "../jobs/provider-target-change.js";
import { probeSchedulerStorage } from "../jobs/storage-probe.js";
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
import {
  createProviderRuntime,
  type ProviderRuntimeOptions,
} from "../providers/runtime.js";
import {
  ProviderServiceError,
  type ProviderService,
} from "./providers/provider-service.js";
import { createProviderTargetChangeCoordinator } from "./providers/provider-target-coordinator.js";

export interface RuntimeOptions {
  dataDir?: string;
  serveUi?: boolean;
  uiRoot?: string;
  enableTestRoutes?: boolean;
  seedTemplateInstaller?: SeedTemplateInstaller;
  providers?: ProviderRuntimeOptions;
  jobs?: JobRuntimeOptions;
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
  jobs: JobRuntime;
  creative: CreativeRuntime;
}

export interface CreativeRuntime {
  sheets: CreativeSheetService;
  sheetPipeline: CreativeSheetPipeline;
  pipeline: CreativePipelineService;
  pages: CreativePageService;
  invalidation: CreativeInvalidationService;
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
  const context = {
    options,
    paths,
    store,
    assets,
    originals,
    settings,
    library,
    authoring,
  };
  const infrastructure = createInfrastructure({
    ...context,
    boundary,
    initialIntegrity,
  });
  const metrics = { listenAttempts: 0, routeDispatches: 0 };
  const app = await configureHttpApp({
    ...context,
    ...infrastructure,
    sentinel,
    boundary,
    metrics,
  });
  return finish(
    app,
    store,
    boundary,
    sentinel,
    paths,
    metrics,
    infrastructure.logger,
    infrastructure.jobs,
    infrastructure.creative,
  );
}

async function configureHttpApp(input: {
  options: RuntimeOptions;
  store: DocumentStore;
  assets: AssetStore;
  originals: OriginalAssetStore;
  settings: SettingsService;
  library: LibraryService;
  authoring: AuthoringService;
  sentinel: SecuritySentinel;
  boundary: LocalRequestBoundary;
  metrics: RuntimeMetrics;
  logger: StructuredLogger;
  health: HealthService;
  providers: ReturnType<typeof createProviderRuntime>["service"];
  jobs: JobRuntime;
  creative: CreativeRuntime;
  targetChanges: ProviderTargetChangeCoordinator;
}): Promise<FastifyInstance> {
  const photoIntake = new PhotoIntakeCoordinator(
    input.store,
    input.assets,
    input.originals,
    input.settings,
    input.library,
  );
  const app = createHttpApp(input.boundary, input.metrics, input.logger);
  await registerMultipart(app);
  registerApi(app, {
    assets: input.assets,
    settings: input.settings,
    library: input.library,
    authoring: input.authoring,
    photoIntake,
    health: input.health,
    providers: input.providers,
    jobs: input.jobs,
    creative: input.creative,
    targetChanges: input.targetChanges,
    boundary: input.boundary,
    sentinel: input.sentinel,
    enableTestRoutes: input.options.enableTestRoutes ?? false,
  });
  await registerUi(app, input.options);
  return app;
}

function createInfrastructure(input: {
  options: RuntimeOptions;
  paths: DataPaths;
  store: DocumentStore;
  assets: AssetStore;
  originals: OriginalAssetStore;
  settings: SettingsService;
  library: LibraryService;
  authoring: AuthoringService;
  boundary: LocalRequestBoundary;
  initialIntegrity: Awaited<ReturnType<AssetStore["scanIntegrity"]>>;
}) {
  const logger = createRuntimeLogger(input);
  const providerRuntime = createProviderRuntime(
    input.settings,
    logger.redactor,
    input.options.providers,
  );
  const creative = createCreativeRuntime(input);
  const jobs = createJobs(input, providerRuntime, creative);
  creative.sheets.bindScheduler(jobs.scheduler);
  creative.sheetPipeline.bindScheduler(jobs.scheduler);
  creative.pipeline.bindScheduler(jobs.scheduler);
  const targetChanges = createProviderTargetChangeCoordinator(
    input.settings,
    jobs,
    providerRuntime.service,
  );
  const health = new HealthService(
    input.store,
    input.assets,
    input.settings,
    input.boundary,
    input.paths,
    input.initialIntegrity,
    input.originals,
    providerRuntime.service,
    jobs,
  );
  return {
    logger,
    providers: providerRuntime.service,
    jobs,
    creative,
    health,
    targetChanges,
  };
}

function createRuntimeLogger(
  input: Parameters<typeof createInfrastructure>[0],
): StructuredLogger {
  return new StructuredLogger(
    createFileLogSink(join(input.paths.logs, "app.log")),
    new Redactor(input.store.secretRegistry),
  );
}

function createCreativeRuntime(
  input: Parameters<typeof createInfrastructure>[0],
): CreativeRuntime {
  const sheets = new CreativeSheetService(input.store, input.assets, null);
  const capacityLimits = (
    target: Parameters<typeof configuredCreativeLimits>[0],
  ) => configuredCreativeLimits(target, input.options.providers?.geminiLimits);
  return {
    sheets,
    sheetPipeline: new CreativeSheetPipeline(
      input.store,
      input.library,
      input.authoring,
      input.settings,
      sheets,
      { capacityLimits },
    ),
    pipeline: new CreativePipelineService(
      input.store,
      input.library,
      input.authoring,
      input.settings,
      { capacityLimits },
    ),
    pages: new CreativePageService(input.store),
    invalidation: new CreativeInvalidationService(input.store),
  };
}

function createJobs(
  input: Parameters<typeof createInfrastructure>[0],
  providerRuntime: ReturnType<typeof createProviderRuntime>,
  creative: CreativeRuntime,
): JobRuntime {
  const exactCapabilities = new ExactCapabilityBroker(
    providerRuntime.registry,
    providerRuntime.capabilityCache,
    input.options.providers?.monotonicNow,
  );
  const quotaAvailability =
    input.options.jobs?.quotaAvailability ??
    new QuotaAvailabilityBroker(exactCapabilities);
  const credentialAvailability =
    input.options.jobs?.credentialAvailability ??
    new CredentialAvailabilityBroker(exactCapabilities);
  const preDispatch = new PreDispatchCoordinator(
    exactCapabilities,
    createLibraryImageReferenceResolver(
      input.library,
      input.assets,
      creative.sheets,
    ),
  );
  const gateway = new ProviderDispatchGateway(providerRuntime.registry);
  const holder: { runtime: JobRuntime | null } = { runtime: null };
  const definitions = createCreativeJobDefinitions({
    pipeline: creative.pipeline,
    sheets: creative.sheets,
    assets: input.assets,
    preDispatch,
    gateway,
    scheduler: () => {
      if (!holder.runtime) throw new Error("JOB_RUNTIME_NOT_READY");
      return holder.runtime.scheduler;
    },
  });
  const runtime = new JobRuntime(
    input.store,
    createJobRuntimeOptions(
      input,
      providerRuntime,
      definitions,
      quotaAvailability,
      credentialAvailability,
    ),
  );
  holder.runtime = runtime;
  return runtime;
}

function createJobRuntimeOptions(
  input: Parameters<typeof createInfrastructure>[0],
  providerRuntime: ReturnType<typeof createProviderRuntime>,
  definitions: ReturnType<typeof createCreativeJobDefinitions>,
  quotaAvailability: JobRuntimeOptions["quotaAvailability"],
  credentialAvailability: JobRuntimeOptions["credentialAvailability"],
): JobRuntimeOptions {
  return {
    ...input.options.jobs,
    definitions: [...definitions, ...(input.options.jobs?.definitions ?? [])],
    concurrencyPerProvider:
      input.options.jobs?.concurrencyPerProvider ??
      input.settings.get().concurrencyPerProvider,
    getConcurrencyPerProvider:
      input.options.jobs?.getConcurrencyPerProvider ??
      (input.options.jobs?.concurrencyPerProvider === undefined
        ? () => input.settings.get().concurrencyPerProvider
        : undefined),
    storageProbe:
      input.options.jobs?.storageProbe ??
      (() =>
        probeSchedulerStorage({
          paths: input.paths,
          database: input.store,
          minimumFreeBytes: input.settings.get().diskWarnGb * 1024 ** 3,
        })),
    quotaAvailability,
    credentialAvailability,
    quotaAlternates:
      input.options.jobs?.quotaAlternates ??
      ((incident) =>
        cachedQuotaAlternates(
          providerRuntime.service,
          input.settings,
          incident,
        )),
  };
}

function cachedQuotaAlternates(
  providers: ProviderService,
  settings: SettingsService,
  incident: QuotaIncident,
) {
  const current = settings.get();
  return providers
    .cachedAvailableTargets(incident.operation)
    .filter((target) => target.providerId !== incident.providerId)
    .map((target) =>
      createJobTarget({
        ...target,
        configuration: {
          imageTier:
            target.providerId === "gemini" && target.operation === "image"
              ? current.geminiImageTier
              : null,
        },
      }),
    );
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

function finish(
  app: FastifyInstance,
  store: DocumentStore,
  boundary: LocalRequestBoundary,
  sentinel: SecuritySentinel,
  paths: DataPaths,
  metrics: RuntimeMetrics,
  logger: StructuredLogger,
  jobs: JobRuntime,
  creative: CreativeRuntime,
): HekayatiRuntime {
  const close = runtimeCloser(app, store, boundary, jobs);
  return {
    app,
    paths,
    metrics,
    jobs,
    creative,
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
        jobs.start();
        return boundary.bootstrap().canonicalOrigin;
      } catch (error) {
        await close();
        throw error;
      }
    },
    close,
  };
}

function runtimeCloser(
  app: FastifyInstance,
  store: DocumentStore,
  boundary: LocalRequestBoundary,
  jobs: JobRuntime,
): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    let failure: unknown;
    try {
      await jobs.stop();
    } catch (error) {
      failure = error;
    }
    try {
      boundary.deactivate();
    } catch (error) {
      failure ??= error;
    }
    try {
      await app.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      store.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw runtimeCloseError(failure);
  };
}

function runtimeCloseError(error: unknown): Error {
  return error instanceof Error ? error : new Error("RUNTIME_CLOSE_FAILED");
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
  if (handleValidationError(error, reply)) return;
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
  if (error instanceof CreativeError) {
    void reply
      .code(error.statusCode)
      .send({ code: error.code, details: error.details });
    return;
  }
  if (error instanceof PhotoIntakeError) {
    void reply.code(error.statusCode).send(error.toSafeResponse());
    return;
  }
  if (
    error instanceof PhotoReservationError ||
    error instanceof ProviderServiceError ||
    error instanceof ProviderTargetChangeError ||
    error instanceof JobError
  ) {
    void reply.code(error.statusCode).send({ code: error.code });
    return;
  }
  handleUnexpectedError(error, reply, logger);
}

function handleUnexpectedError(
  error: unknown,
  reply: FastifyReply,
  logger: StructuredLogger,
): void {
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

function handleValidationError(error: unknown, reply: FastifyReply): boolean {
  if (!(error instanceof ZodError)) return false;
  void reply.code(400).send({
    code: "INVALID_INPUT",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
  return true;
}

function clientErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("statusCode" in error))
    return null;
  const status = error.statusCode;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : null;
}
