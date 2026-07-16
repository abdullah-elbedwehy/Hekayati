import { existsSync } from "node:fs";
import { join } from "node:path";

import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { AssetStore, type AssetStoreHooks } from "../assets/asset-store.js";
import { OriginalAssetStore } from "../assets/original-asset-store.js";
import { LOOPBACK_HOST } from "../config/defaults.js";
import {
  prepareDataPaths,
  resolveDataPaths,
  type DataPaths,
} from "../config/paths.js";
import { DocumentStore } from "../domain/repository/document-store.js";
import { initializeLayoutPersistence } from "../domain/layout/migrations.js";
import {
  ApprovedBookSnapshotReader,
  BookApprovalService,
  CurrentPreviewCustomerContentReader,
} from "../domain/layout/approvals.js";
import { PreviewWorkflowCoordinator } from "../domain/layout/workflow.js";
import { LayoutWorkspaceService } from "../domain/layout/workspace.js";
import { AuthoringService } from "../domain/authoring/index.js";
import { LibraryService } from "../domain/library/index.js";
import { SettingsService } from "../domain/settings/settings.js";
import {
  CreativeInvalidationService,
  configuredCreativeLimits,
  CreativePageService,
  CreativePipelineService,
  CreativeSheetPipeline,
  CreativeSheetService,
} from "../domain/creative/index.js";
import { SecuritySentinel } from "../domain/system/sentinel.js";
import {
  CredentialAvailabilityBroker,
  ExactCapabilityBroker,
  QuotaAvailabilityBroker,
} from "../jobs/capabilities.js";
import { JobRuntime, type JobRuntimeOptions } from "../jobs/runtime.js";
import { createCreativeJobDefinitions } from "../jobs/creative-definitions.js";
import { createLayoutJobDefinitions } from "../jobs/layout-definitions.js";
import { createLibraryImageReferenceResolver } from "../jobs/image-references.js";
import { PreDispatchCoordinator } from "../jobs/pre-dispatch.js";
import { ProviderDispatchGateway } from "../jobs/provider-dispatch.js";
import type { QuotaIncident } from "../jobs/schemas.js";
import type { RegisteredJobDefinition } from "../jobs/types.js";
import { createJobTarget } from "../jobs/targets.js";
import type { ProviderTargetChangeCoordinator } from "../jobs/provider-target-change.js";
import { probeSchedulerStorage } from "../jobs/storage-probe.js";
import type { StructuredLogger } from "../security/log.js";
import {
  HealthService,
  mergeIntegrityReports,
} from "./health/health-service.js";
import { registerApi } from "./routes/api.js";
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
import type { ProviderService } from "./providers/provider-service.js";
import { createProviderTargetChangeCoordinator } from "./providers/provider-target-coordinator.js";
import { handleError } from "./error-handler.js";
import {
  createPrintJobDefinitions,
  createPrintRuntime,
  type PrintJobPorts,
  type PrintProductionHolder,
  type PrintRuntime,
} from "./print-runtime.js";
import { createRuntimeLogger } from "./runtime-logger.js";

export interface RuntimeOptions {
  dataDir?: string;
  serveUi?: boolean;
  uiRoot?: string;
  enableTestRoutes?: boolean;
  seedTemplateInstaller?: SeedTemplateInstaller;
  providers?: ProviderRuntimeOptions;
  jobs?: JobRuntimeOptions;
  assetStoreHooks?: AssetStoreHooks;
  printJobs?: PrintJobPorts;
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
  layout: LayoutRuntime;
  print: PrintRuntime;
}

export interface CreativeRuntime {
  sheets: CreativeSheetService;
  sheetPipeline: CreativeSheetPipeline;
  pipeline: CreativePipelineService;
  pages: CreativePageService;
  invalidation: CreativeInvalidationService;
}

export interface LayoutRuntime {
  workflow: PreviewWorkflowCoordinator;
  workspace: LayoutWorkspaceService;
  approvals: BookApprovalService;
  approvedSnapshots: ApprovedBookSnapshotReader;
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
    initializeLayoutPersistence(store);
    await (
      options.seedTemplateInstaller ?? productionSeedTemplateInstaller
    ).install(store);
    const assets = new AssetStore(store, paths.assets, options.assetStoreHooks);
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
    infrastructure.layout,
    infrastructure.print,
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
  layout: LayoutRuntime;
  print: PrintRuntime;
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
    layout: input.layout,
    print: input.print,
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
  const logger = createRuntimeLogger(input.paths.logs, input.store);
  const providerRuntime = createProviderRuntime(
    input.settings,
    logger.redactor,
    input.options.providers,
  );
  const creative = createCreativeRuntime(input);
  const { jobs, layout, print } = createDeliveryRuntimes(
    input,
    providerRuntime,
    creative,
  );
  const { targetChanges, health } = createInfrastructureSupport(
    input,
    providerRuntime.service,
    jobs,
    creative.invalidation,
  );
  return {
    logger,
    providers: providerRuntime.service,
    jobs,
    creative,
    layout,
    print,
    health,
    targetChanges,
  };
}

function createDeliveryRuntimes(
  input: Parameters<typeof createInfrastructure>[0],
  providerRuntime: ReturnType<typeof createProviderRuntime>,
  creative: CreativeRuntime,
) {
  const layoutWorkflow = new PreviewWorkflowCoordinator(
    input.store,
    input.assets,
    input.settings,
  );
  const printHolder: PrintProductionHolder = { production: null };
  const jobs = createJobs(
    input,
    providerRuntime,
    creative,
    layoutWorkflow,
    printHolder,
  );
  bindRuntimeServices(
    input.authoring,
    input.settings,
    creative,
    layoutWorkflow,
    jobs,
  );
  const layout = createLayoutRuntime(input, layoutWorkflow, jobs);
  const print = createPrintRuntime({
    store: input.store,
    assets: input.assets,
    jobs,
    approvedSnapshots: layout.approvedSnapshots,
    invalidation: creative.invalidation,
    holder: printHolder,
  });
  creative.invalidation.bindParticipant(print.invalidation);
  return { jobs, layout, print };
}

function createInfrastructureSupport(
  input: Parameters<typeof createInfrastructure>[0],
  providers: ProviderService,
  jobs: JobRuntime,
  invalidation: CreativeInvalidationService,
) {
  return {
    targetChanges: createProviderTargetChangeCoordinator(
      input.settings,
      jobs,
      providers,
    ),
    health: createHealthService(input, providers, jobs, invalidation),
  };
}

function createHealthService(
  input: Parameters<typeof createInfrastructure>[0],
  providers: ProviderService,
  jobs: JobRuntime,
  invalidation: CreativeInvalidationService,
): HealthService {
  return new HealthService(
    input.store,
    input.assets,
    input.settings,
    input.boundary,
    input.paths,
    input.initialIntegrity,
    input.originals,
    providers,
    jobs,
    invalidation,
  );
}

function bindRuntimeServices(
  authoring: AuthoringService,
  settings: SettingsService,
  creative: CreativeRuntime,
  layoutWorkflow: PreviewWorkflowCoordinator,
  jobs: JobRuntime,
): void {
  authoring.bindInvalidation(creative.invalidation);
  settings.bindInvalidation(creative.invalidation);
  creative.sheets.bindScheduler(jobs.scheduler);
  creative.sheetPipeline.bindScheduler(jobs.scheduler);
  creative.pipeline.bindScheduler(jobs.scheduler);
  creative.pipeline.bindPreviewWorkflow(layoutWorkflow);
  creative.invalidation.bindGateController(jobs.scheduler);
  layoutWorkflow.bindInvalidation(creative.invalidation);
  layoutWorkflow.bindScheduler(jobs.scheduler);
}

function createLayoutRuntime(
  input: Parameters<typeof createInfrastructure>[0],
  workflow: PreviewWorkflowCoordinator,
  jobs: JobRuntime,
): LayoutRuntime {
  return {
    workflow,
    workspace: new LayoutWorkspaceService(
      input.store,
      jobs.scheduler,
      input.assets,
    ),
    approvals: new BookApprovalService(input.store, jobs.scheduler),
    approvedSnapshots: new ApprovedBookSnapshotReader(
      input.store,
      jobs.scheduler,
      input.assets,
      new CurrentPreviewCustomerContentReader(input.store),
    ),
  };
}

function createCreativeRuntime(
  input: Parameters<typeof createInfrastructure>[0],
): CreativeRuntime {
  const sheets = new CreativeSheetService(input.store, input.assets, null);
  const invalidation = new CreativeInvalidationService(input.store);
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
    pages: new CreativePageService(input.store, { invalidation }),
    invalidation,
  };
}

function createJobs(
  input: Parameters<typeof createInfrastructure>[0],
  providerRuntime: ReturnType<typeof createProviderRuntime>,
  creative: CreativeRuntime,
  layoutWorkflow: PreviewWorkflowCoordinator,
  printHolder: PrintProductionHolder,
): JobRuntime {
  const exactCapabilities = new ExactCapabilityBroker(
    providerRuntime.registry,
    providerRuntime.capabilityCache,
    input.options.providers?.monotonicNow,
  );
  const { quotaAvailability, credentialAvailability } =
    createAvailabilityBrokers(input, exactCapabilities);
  const preDispatch = createPreDispatchCoordinator(
    input,
    creative,
    exactCapabilities,
  );
  const gateway = new ProviderDispatchGateway(providerRuntime.registry);
  const holder: { runtime: JobRuntime | null } = { runtime: null };
  const definitions = createAllJobDefinitions({
    creative,
    assets: input.assets,
    layoutWorkflow,
    preDispatch,
    gateway,
    store: input.store,
    printHolder,
    printPorts: input.options.printJobs,
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

function createAvailabilityBrokers(
  input: Parameters<typeof createInfrastructure>[0],
  capabilities: ExactCapabilityBroker,
) {
  return {
    quotaAvailability:
      input.options.jobs?.quotaAvailability ??
      new QuotaAvailabilityBroker(capabilities),
    credentialAvailability:
      input.options.jobs?.credentialAvailability ??
      new CredentialAvailabilityBroker(capabilities),
  };
}

function createPreDispatchCoordinator(
  input: Parameters<typeof createInfrastructure>[0],
  creative: CreativeRuntime,
  capabilities: ExactCapabilityBroker,
): PreDispatchCoordinator {
  return new PreDispatchCoordinator(
    capabilities,
    createLibraryImageReferenceResolver(
      input.library,
      input.assets,
      creative.sheets,
    ),
  );
}

function createAllJobDefinitions(input: {
  creative: CreativeRuntime;
  assets: AssetStore;
  layoutWorkflow: PreviewWorkflowCoordinator;
  preDispatch: PreDispatchCoordinator;
  gateway: ProviderDispatchGateway;
  scheduler: () => JobRuntime["scheduler"];
  store: DocumentStore;
  printHolder: PrintProductionHolder;
  printPorts: PrintJobPorts | undefined;
}): RegisteredJobDefinition[] {
  return [
    ...createCreativeJobDefinitions({
      pipeline: input.creative.pipeline,
      sheets: input.creative.sheets,
      assets: input.assets,
      preDispatch: input.preDispatch,
      gateway: input.gateway,
      scheduler: input.scheduler,
    }),
    ...createLayoutJobDefinitions({
      assets: input.assets,
      workflow: input.layoutWorkflow,
      scheduler: input.scheduler,
    }),
    ...createPrintJobDefinitions({
      store: input.store,
      assets: input.assets,
      holder: input.printHolder,
      ports: input.printPorts,
    }),
  ];
}

function createJobRuntimeOptions(
  input: Parameters<typeof createInfrastructure>[0],
  providerRuntime: ReturnType<typeof createProviderRuntime>,
  definitions: readonly RegisteredJobDefinition[],
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
  layout: LayoutRuntime,
  print: PrintRuntime,
): HekayatiRuntime {
  const close = runtimeCloser(app, store, boundary, jobs);
  return {
    app,
    paths,
    metrics,
    jobs,
    creative,
    layout,
    print,
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
