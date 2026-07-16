import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { z } from "zod";

import {
  AssetStore,
  assetRecordSchema,
  type AssetRecord,
  type AssetStoreHooks,
} from "../../src/assets/asset-store.js";
import {
  OriginalAssetStore,
  originalAssetRecordSchema,
  type OriginalAssetRecord,
  type OriginalAssetStoreHooks,
} from "../../src/assets/original-asset-store.js";
import {
  prepareDataPaths,
  resolveDataPaths,
  type DataPaths,
} from "../../src/config/paths.js";
import { canonicalJson } from "../../src/contracts/canonical-json.js";
import type { ImportCommitRequest } from "../../src/domain/portability/import-apply-model.js";
import { rewritePortabilityParticipantIds } from "../../src/domain/portability/import-id-rules.js";
import {
  ImportPlanService,
  type ImportPlanResult,
} from "../../src/domain/portability/import-plan.js";
import type {
  ImportPlan,
  ImportPlanRequest,
} from "../../src/domain/portability/import-plan-model.js";
import type { ImportPlanSourceBundle } from "../../src/domain/portability/import-plan-selection.js";
import { ImportPlanRepository } from "../../src/domain/portability/import-plan-storage.js";
import {
  DocumentStoreImportPlanTargetReader,
  type ImportPlanTargetReader,
} from "../../src/domain/portability/import-plan-target.js";
import { rebaseParticipantDerivedFields } from "../../src/domain/portability/import-rebase.js";
import type { ImportOperation } from "../../src/domain/portability/import-model.js";
import { ImportOperationRepository } from "../../src/domain/portability/import-storage.js";
import { ImportUploadService } from "../../src/domain/portability/import-upload.js";
import { ImportValidationService } from "../../src/domain/portability/import-validation-service.js";
import {
  createPortabilityRegistry,
  definePortabilityParticipant,
  type ExactIdMap,
  type PortabilityCatalog,
  type PortabilityDocumentReference,
  type PortabilityImportValidationContext,
  type PortabilityMediaReference,
  type PortabilityRegistry,
} from "../../src/domain/portability/participants.js";
import {
  PortabilityActionRepository,
  PortabilityLedgerRepository,
} from "../../src/domain/portability/repositories.js";
import {
  DocumentStore,
  type BaseDocument,
} from "../../src/domain/repository/document-store.js";
import { calculateImportDiskFacts } from "../../src/portability/disk-preflight.js";
import {
  writeDeterministicArchive,
  type StagedArchiveSource,
} from "../../src/portability/export.js";
import { loadValidatedImportSource } from "../../src/portability/import-staging-reader.js";
import { ManagedImportStore } from "../../src/portability/import.js";
import {
  createManifest,
  type ManifestV2,
} from "../../src/portability/manifest.js";
import {
  ManagedDeletionCleanup,
  type ManagedDeletionCleanupHooks,
} from "../../src/portability/deletion-cleanup.js";
import { SecretReleaseGate } from "../../src/portability/secret-scan.js";
import { SecretRegistry } from "../../src/security/secret-registry.js";
import { temporaryDirectory } from "./temp.js";

export const importApplyFixtureAt = "2026-07-16T23:45:00.000Z";

export const importApplyFixtureIds = Object.freeze({
  installation: fixtureId(1),
  operation: fixtureId(2),
  reservation: fixtureId(3),
  uploadAction: fixtureId(4),
  staging: fixtureId(5),
  export: fixtureId(6),
  sourceCustomer: fixtureId(7),
  sourceFamily: fixtureId(8),
  sourceProject: fixtureId(9),
  sourceAsset: fixtureId(10),
  sourceOriginal: fixtureId(11),
});

export interface ImportApplyArchiveFixture {
  readonly bytes: Buffer;
  readonly manifest: ManifestV2;
  readonly assetBytes: Buffer;
  readonly originalBytes: Buffer;
  readonly sourceAsset: AssetRecord;
  readonly sourceOriginal: OriginalAssetRecord;
}

export interface ImportApplyFixtureOptions {
  readonly assetHooks?: AssetStoreHooks;
  readonly originalHooks?: OriginalAssetStoreHooks;
  readonly cleanupHooks?: ManagedDeletionCleanupHooks;
}

export interface ImportApplyFixture {
  readonly directory: string;
  readonly paths: DataPaths;
  readonly store: DocumentStore;
  readonly registry: PortabilityRegistry;
  readonly managedImports: ManagedImportStore;
  readonly managedExportsRoot: string;
  readonly assets: AssetStore;
  readonly originals: OriginalAssetStore;
  readonly cleanup: ManagedDeletionCleanup;
  readonly operations: ImportOperationRepository;
  readonly plans: ImportPlanRepository;
  readonly actions: PortabilityActionRepository;
  readonly ledgers: PortabilityLedgerRepository;
  readonly targetReader: ImportPlanTargetReader;
  readonly archive: ImportApplyArchiveFixture;
  readonly planReadyOperation: ImportOperation;
  readonly operation: ImportOperation;
  readonly planRequest: ImportPlanRequest;
  readonly request: ImportCommitRequest;
  readonly plan: ImportPlan;
  readonly planResult: ImportPlanResult;
  readonly source: ImportPlanSourceBundle;
  readonly sourceProofHash: string;
  readonly stagingDirectory: string;
  readonly readMedia: (
    namespace: "asset" | "original",
    id: string,
  ) => Promise<Buffer>;
  readonly nextApplyId: () => string;
  cleanupNow(): Promise<void>;
}

/**
 * Builds the complete upload -> validate -> plan boundary used by import-apply
 * tests. Product collections remain empty until the apply service commits.
 */
export async function createImportApplyFixture(
  options: ImportApplyFixtureOptions = {},
): Promise<ImportApplyFixture> {
  const directory = await temporaryDirectory("hekayati-import-apply-");
  const paths = resolveDataPaths(join(directory.path, "data"));
  await prepareDataPaths(paths);
  const store = new DocumentStore(paths.database);
  let cleaned = false;
  const cleanupNow = async () => {
    if (cleaned) return;
    cleaned = true;
    store.close();
    await directory.cleanup();
  };

  try {
    const registry = importApplyFixtureRegistry();
    const archive = await createImportApplyArchive();
    const managedImports = new ManagedImportStore(join(paths.root, "imports"));
    const assets = new AssetStore(store, paths.assets, options.assetHooks);
    const originals = new OriginalAssetStore(
      store,
      paths.originals,
      options.originalHooks,
    );
    const operations = new ImportOperationRepository(
      store,
      () => importApplyFixtureIds.installation,
    );
    const plans = new ImportPlanRepository(store);
    const actions = new PortabilityActionRepository(store);
    const ledgers = new PortabilityLedgerRepository(store);
    const targetReader = new DocumentStoreImportPlanTargetReader(store);
    const uploadIds = sequence([
      importApplyFixtureIds.operation,
      importApplyFixtureIds.reservation,
      importApplyFixtureIds.uploadAction,
    ]);
    const upload = new ImportUploadService(
      store,
      operations,
      actions,
      managedImports,
      {
        nowIso: () => importApplyFixtureAt,
        idFactory: uploadIds,
      },
    );
    const uploaded = await upload.upload({
      idempotencyKey: "apply-fixture-upload",
      declaredArchiveHash: sha256(archive.bytes),
      declaredArchiveBytes: archive.bytes.byteLength,
      openSource: () => Readable.from(archive.bytes),
    });
    const validation = new ImportValidationService(
      store,
      operations,
      registry,
      managedImports,
      new SecretReleaseGate(new SecretRegistry()),
      {
        reserveBytes: 1024,
        nowIso: () => importApplyFixtureAt,
        idFactory: () => importApplyFixtureIds.staging,
        diskPreflight: async (input) =>
          calculateImportDiskFacts({
            freeBytes: 32 * 1024 ** 3,
            reserveBytes: input.reserveBytes,
            declaredUncompressedBytes: input.declaredUncompressedBytes,
            newContentBytes: input.newContentBytes,
            canonicalDocumentBytes: input.canonicalDocumentBytes,
          }),
      },
    );
    const planReadyOperation = await validation.validate(uploaded.current.id);
    if (!planReadyOperation.stagingKey)
      throw new Error("IMPORT_APPLY_FIXTURE_STAGING_MISSING");
    const stagingDirectory = managedImports.stagingPath(
      planReadyOperation.stagingKey,
    );
    const loaded = await loadValidatedImportSource({
      directory: stagingDirectory,
      operation: planReadyOperation,
      registry,
    });
    const planRequest = asNewPlanRequest(planReadyOperation);
    const planService = new ImportPlanService(
      store,
      operations,
      plans,
      actions,
      ledgers,
      registry,
      targetReader,
      {
        nowIso: () => importApplyFixtureAt,
        idFactory: deterministicImportApplyIdFactory(100),
      },
    );
    const planResult = planService.plan(
      planReadyOperation.id,
      planRequest,
      loaded.source,
    );
    const request: ImportCommitRequest = {
      idempotencyKey: "apply-fixture-commit",
      expectedOperationRevision: planResult.current.revision,
      planId: planResult.plan.id,
      confirmationHash: planResult.plan.confirmationHash,
      finalConfirmation: true,
    };
    const managedExportsRoot = join(paths.root, "exports");
    const cleanup = new ManagedDeletionCleanup({
      store,
      assets,
      originals,
      managedExportsRoot,
      hooks: options.cleanupHooks,
    });

    return {
      directory: directory.path,
      paths,
      store,
      registry,
      managedImports,
      managedExportsRoot,
      assets,
      originals,
      cleanup,
      operations,
      plans,
      actions,
      ledgers,
      targetReader,
      archive,
      planReadyOperation,
      operation: planResult.current,
      planRequest,
      request,
      plan: planResult.plan,
      planResult,
      source: loaded.source,
      sourceProofHash: loaded.sourceProofHash,
      stagingDirectory,
      readMedia: loaded.readMedia,
      nextApplyId: deterministicImportApplyIdFactory(500),
      cleanupNow,
    };
  } catch (error) {
    await cleanupNow();
    throw error;
  }
}

export function deterministicImportApplyIdFactory(start = 1): () => string {
  let value = start;
  return () => fixtureId(value++);
}

function asNewPlanRequest(operation: ImportOperation): ImportPlanRequest {
  return {
    idempotencyKey: "apply-fixture-plan",
    expectedOperationRevision: operation.revision,
    mode: "as_new_project",
    sourceRoot: {
      projectId: importApplyFixtureIds.sourceProject,
      customerId: importApplyFixtureIds.sourceCustomer,
      familyId: importApplyFixtureIds.sourceFamily,
    },
    customerResolution: { kind: "create_from_archive" },
    replaceTarget: null,
    selectedCharacterIds: [],
    selectedTemplateIds: [],
    templateCatalogRevisionHash: null,
    explicitMappings: [],
    approvalPolicy: "demote",
  };
}

async function createImportApplyArchive(): Promise<ImportApplyArchiveFixture> {
  const assetBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
    "base64",
  );
  const originalBytes = Buffer.from(assetBytes);
  const sourceAsset = assetRecordSchema.parse({
    id: importApplyFixtureIds.sourceAsset,
    schemaVersion: 1,
    createdAt: importApplyFixtureAt,
    updatedAt: importApplyFixtureAt,
    sha256: sha256(assetBytes),
    extension: "png",
    bytes: assetBytes.byteLength,
    refCount: 1,
    mime: "image/png",
    width: 1,
    height: 1,
    role: "illustration",
    origin: "derived",
  });
  const sourceOriginal = originalAssetRecordSchema.parse({
    id: importApplyFixtureIds.sourceOriginal,
    schemaVersion: 1,
    createdAt: importApplyFixtureAt,
    updatedAt: importApplyFixtureAt,
    sha256: sha256(originalBytes),
    sourceMime: "image/png",
    extension: "png",
    bytes: originalBytes.byteLength,
    refCount: 1,
  });
  const documents = [
    archiveDocument("customers", {
      id: importApplyFixtureIds.sourceCustomer,
      schemaVersion: 1,
      createdAt: importApplyFixtureAt,
      updatedAt: importApplyFixtureAt,
      name: "Synthetic apply customer",
      consent: { granted: true },
    }),
    archiveDocument("families", {
      id: importApplyFixtureIds.sourceFamily,
      schemaVersion: 1,
      createdAt: importApplyFixtureAt,
      updatedAt: importApplyFixtureAt,
      customerId: importApplyFixtureIds.sourceCustomer,
      name: "Synthetic apply family",
    }),
    archiveDocument("projects", {
      id: importApplyFixtureIds.sourceProject,
      schemaVersion: 1,
      createdAt: importApplyFixtureAt,
      updatedAt: importApplyFixtureAt,
      customerId: importApplyFixtureIds.sourceCustomer,
      familyId: importApplyFixtureIds.sourceFamily,
      assetId: importApplyFixtureIds.sourceAsset,
      originalAssetId: importApplyFixtureIds.sourceOriginal,
      revision: 0,
      status: "draft",
      paused: false,
      currentContentApprovalId: null,
    }),
    archiveDocument("assets", sourceAsset),
    archiveDocument("original_assets", sourceOriginal),
  ];
  const manifest = createManifest({
    appVersion: "0.1.0-test",
    createdAt: importApplyFixtureAt,
    exportId: importApplyFixtureIds.export,
    mode: "project",
    scope: {
      kind: "project",
      projectId: importApplyFixtureIds.sourceProject,
      customerId: importApplyFixtureIds.sourceCustomer,
      familyId: importApplyFixtureIds.sourceFamily,
    },
    roots: [
      { kind: "project", id: importApplyFixtureIds.sourceProject },
      { kind: "customer", id: importApplyFixtureIds.sourceCustomer },
      { kind: "family", id: importApplyFixtureIds.sourceFamily },
    ],
    documents: documents.map((item) => ({
      collection: item.collection,
      id: item.id,
      schemaVersion: item.schemaVersion,
      bytes: item.bytes.byteLength,
      sha256: sha256(item.bytes),
    })),
    media: [
      {
        namespace: "asset",
        assetId: sourceAsset.id,
        role: "illustration",
        mime: sourceAsset.mime,
        extension: sourceAsset.extension,
        bytes: sourceAsset.bytes,
        sha256: sourceAsset.sha256,
      },
      {
        namespace: "original",
        assetId: sourceOriginal.id,
        role: "reference_photo",
        mime: sourceOriginal.sourceMime,
        extension: sourceOriginal.extension,
        bytes: sourceOriginal.bytes,
        sha256: sourceOriginal.sha256,
      },
    ],
    snapshotHash: hash({ documents: documents.map((item) => item.id) }),
  });
  const sourceByPath = new Map<string, Buffer>();
  for (const item of documents)
    sourceByPath.set(`data/${item.collection}/${item.id}.json`, item.bytes);
  for (const entry of manifest.media)
    sourceByPath.set(
      entry.path,
      entry.namespace === "asset" ? assetBytes : originalBytes,
    );
  const sources: StagedArchiveSource[] = [
    ...manifest.documents,
    ...manifest.media,
  ].map((entry) => ({
    path: entry.path,
    bytes: entry.bytes,
    sha256: entry.sha256,
    open: () => Readable.from(sourceByPath.get(entry.path)!),
  }));
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await writeDeterministicArchive(manifest, sources, output);
  return {
    bytes: Buffer.concat(chunks),
    manifest,
    assetBytes,
    originalBytes,
    sourceAsset,
    sourceOriginal,
  };
}

const baseFields = {
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

const customerSchema = z
  .object({
    ...baseFields,
    name: z.string(),
    consent: z.object({ granted: z.boolean() }).strict().nullable(),
  })
  .strict();

const familySchema = z
  .object({
    ...baseFields,
    customerId: baseFields.id,
    name: z.string(),
  })
  .strict();

const projectSchema = z
  .object({
    ...baseFields,
    customerId: baseFields.id,
    familyId: baseFields.id,
    assetId: baseFields.id,
    originalAssetId: baseFields.id,
    revision: z.number().int().nonnegative(),
    status: z.enum(["draft", "preview_ready", "approved", "print_ready"]),
    paused: z.boolean(),
    currentContentApprovalId: baseFields.id.nullable(),
  })
  .strict();

export function importApplyFixtureRegistry(): PortabilityRegistry {
  const customers = definePortabilityParticipant({
    key: "customers",
    collection: "customers",
    currentSchemaVersion: 1,
    schema: customerSchema,
    selectForProject: (document, root) =>
      document.id === root.customerId ? "owning_customer" : null,
    customerIds: (document) => [document.id],
    rewriteIds: (document, idMap) =>
      rewriteDocument("customers", document, idMap),
    rebaseDerivedFields: (document, idMap) =>
      rebaseParticipantDerivedFields("customers", document, idMap),
  });
  const families = definePortabilityParticipant({
    key: "families",
    collection: "families",
    currentSchemaVersion: 1,
    schema: familySchema,
    dependencies: ["customers"],
    selectForProject: (document, root) =>
      document.id === root.familyId ? "owning_family" : null,
    customerIds: (document) => [document.customerId],
    ownerReferences: (document) => [
      reference("customers", document.customerId, "customerId"),
    ],
    rewriteIds: (document, idMap) =>
      rewriteDocument("families", document, idMap, {
        owners: [reference("customers", document.customerId, "customerId")],
      }),
    rebaseDerivedFields: (document, idMap) =>
      rebaseParticipantDerivedFields("families", document, idMap),
  });
  const projects = definePortabilityParticipant({
    key: "projects",
    collection: "projects",
    currentSchemaVersion: 1,
    schema: projectSchema,
    dependencies: ["customers", "families", "assets", "original_assets"],
    selectForProject: (document, root) =>
      document.id === root.projectId ? "project_root" : null,
    projectIds: (document) => [document.id],
    customerIds: (document) => [document.customerId],
    ownerReferences: (document) => [
      reference("customers", document.customerId, "customerId"),
    ],
    references: (document) => [
      reference("families", document.familyId, "familyId"),
    ],
    assetReferences: (document) => [
      mediaReference(document.assetId, "assetId"),
    ],
    originalReferences: (document) => [
      mediaReference(document.originalAssetId, "originalAssetId"),
    ],
    rewriteIds: (document, idMap) =>
      rewriteDocument("projects", document, idMap, {
        owners: [reference("customers", document.customerId, "customerId")],
        references: [reference("families", document.familyId, "familyId")],
        assets: [mediaReference(document.assetId, "assetId")],
        originals: [
          mediaReference(document.originalAssetId, "originalAssetId"),
        ],
      }),
    rebaseDerivedFields: (document, idMap) =>
      rebaseParticipantDerivedFields("projects", document, idMap),
  });
  const assets = definePortabilityParticipant({
    key: "assets",
    collection: "assets",
    currentSchemaVersion: 1,
    schema: assetRecordSchema,
    importValidationKey: "fixture_asset_image:v1",
    claims: { assetRoles: ["illustration"] },
    validateImport: validateAsset,
    rewriteIds: (document, idMap) => rewriteDocument("assets", document, idMap),
    rebaseDerivedFields: (document, idMap) =>
      rebaseParticipantDerivedFields("assets", document, idMap),
  });
  const originals = definePortabilityParticipant({
    key: "original_assets",
    collection: "original_assets",
    currentSchemaVersion: 1,
    schema: originalAssetRecordSchema,
    importValidationKey: "fixture_original_image:v1",
    validateImport: validateOriginal,
    rewriteIds: (document, idMap) =>
      rewriteDocument("original_assets", document, idMap),
    rebaseDerivedFields: (document, idMap) =>
      rebaseParticipantDerivedFields("original_assets", document, idMap),
  });
  const catalog: PortabilityCatalog = {
    collections: [
      "assets",
      "customers",
      "families",
      "original_assets",
      "projects",
    ].map((key) => ({ key, owner: "participant" as const })),
    assetRoles: [{ key: "illustration", owner: "participant" }],
    jobTypes: [],
    scopedWriters: [],
  };
  return createPortabilityRegistry(
    [assets, originals, customers, families, projects],
    catalog,
  );
}

function validateAsset(
  document: Readonly<AssetRecord>,
  context: PortabilityImportValidationContext,
): void {
  const facts = context.media("asset", document.id);
  if (
    !facts ||
    facts.bytes !== document.bytes ||
    facts.sha256 !== document.sha256 ||
    facts.mime !== document.mime ||
    facts.extension !== document.extension ||
    facts.role !== document.role ||
    facts.inspection.kind !== "image"
  )
    throw new Error("IMPORT_APPLY_FIXTURE_ASSET_INVALID");
}

function validateOriginal(
  document: Readonly<OriginalAssetRecord>,
  context: PortabilityImportValidationContext,
): void {
  const facts = context.media("original", document.id);
  if (
    !facts ||
    facts.bytes !== document.bytes ||
    facts.sha256 !== document.sha256 ||
    facts.mime !== document.sourceMime ||
    facts.extension !== document.extension ||
    facts.role !== "reference_photo" ||
    facts.inspection.kind !== "image"
  )
    throw new Error("IMPORT_APPLY_FIXTURE_ORIGINAL_INVALID");
}

function rewriteDocument<T extends BaseDocument>(
  collection: string,
  document: Readonly<T>,
  idMap: ExactIdMap,
  refs: {
    owners?: readonly PortabilityDocumentReference[];
    references?: readonly PortabilityDocumentReference[];
    assets?: readonly PortabilityMediaReference[];
    originals?: readonly PortabilityMediaReference[];
  } = {},
): T {
  return rewritePortabilityParticipantIds({
    collection,
    document,
    idMap,
    ownerReferences: refs.owners ?? [],
    references: refs.references ?? [],
    assetReferences: refs.assets ?? [],
    originalReferences: refs.originals ?? [],
  });
}

function reference(
  collection: string,
  id: string,
  field: string,
): PortabilityDocumentReference {
  return { collection, id, field };
}

function mediaReference(id: string, field: string): PortabilityMediaReference {
  return { id, field, ownership: "owned" };
}

function archiveDocument(
  collection: string,
  document: BaseDocument & Record<string, unknown>,
) {
  return {
    collection,
    id: document.id,
    schemaVersion: document.schemaVersion,
    bytes: Buffer.from(canonicalJson(document)),
  };
}

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("IMPORT_APPLY_FIXTURE_ID_EXHAUSTED");
    index += 1;
    return value;
  };
}

function fixtureId(value: number): string {
  return `01KB${String(value).padStart(22, "0")}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hash(value: unknown): string {
  return sha256(canonicalJson(value));
}
