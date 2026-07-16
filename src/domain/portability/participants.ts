import { createHash } from "node:crypto";

import type { ZodType } from "zod";

import { assetRecordSchema } from "../../assets/asset-store.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import { authoringCollections } from "../authoring/collections.js";
import { creativeCollections } from "../creative/collections.js";
import { layoutCollections } from "../layout/collections.js";
import { libraryCollections } from "../library/collections.js";
import { printCollections } from "../print/collections.js";
import type { BaseDocument } from "../repository/document-store.js";

export type PortabilityExportMode =
  "project" | "customer" | "characters_only" | "templates_only";

export interface ProjectPortabilityRoot {
  kind: "project";
  projectId: string;
  customerId: string;
  familyId: string;
}

export interface CustomerPortabilityRoot {
  kind: "customer";
  customerId: string;
}

export type PortabilityRoot = ProjectPortabilityRoot | CustomerPortabilityRoot;

export interface PortabilityDocumentReference {
  collection: string;
  id: string;
  field: string;
  required?: boolean;
}

export interface PortabilityMediaReference {
  id: string;
  field: string;
  ownership: "owned" | "referenced";
}

export type PortabilityDeletionOrder = "reverse_dependencies";

export interface PortabilityPostDeleteVerificationContract {
  readonly kind: "document_id_absent";
  readonly collection: string;
}

export interface PortabilityPostDeleteVerificationQuery extends PortabilityPostDeleteVerificationContract {
  readonly id: string;
}

export type ExactIdMap = ReadonlyMap<string, string>;

export type PortabilityMediaInspection =
  | {
      readonly kind: "image";
      readonly decoded: true;
      readonly format: "heic" | "heif" | "jpeg" | "png" | "webp";
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "pdf";
      readonly parseable: true;
      readonly encrypted: false;
      readonly prohibitedFeatureCount: 0;
    }
  | {
      readonly kind: "icc";
      readonly signature: "acsp";
      readonly channels: 3 | 4;
      readonly profileClass: "display" | "output";
      readonly checksum: string;
    }
  | { readonly kind: "binary"; readonly executable: false };

export interface PortabilityValidatedMediaFacts {
  readonly namespace: "asset" | "original";
  readonly id: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mime: string;
  readonly extension: string;
  readonly role: string;
  readonly inspection: PortabilityMediaInspection;
}

export interface PortabilityImportValidationContext {
  document(collection: string, id: string): Readonly<BaseDocument> | null;
  media(
    namespace: PortabilityValidatedMediaFacts["namespace"],
    id: string,
  ): PortabilityValidatedMediaFacts | null;
}

export interface PortabilityMigration<T extends BaseDocument> {
  from: number;
  to: number;
  migrate(document: unknown): T;
}

export interface PortabilityCatalogClaims {
  assetRoles?: readonly string[];
  jobTypes?: readonly string[];
  scopedWriters?: readonly string[];
}

export interface PortabilityParticipant<T extends BaseDocument = BaseDocument> {
  readonly key: string;
  readonly collection: string;
  readonly currentSchemaVersion: number;
  readonly schema: ZodType<T>;
  readonly migrations: readonly PortabilityMigration<T>[];
  readonly dependencies: readonly string[];
  readonly exportModes: readonly PortabilityExportMode[];
  readonly deletionOrder: PortabilityDeletionOrder;
  readonly postDeleteVerification: PortabilityPostDeleteVerificationContract;
  readonly importValidationKey: string;
  readonly claims: Readonly<Required<PortabilityCatalogClaims>>;
  selectForProject(
    document: Readonly<T>,
    root: ProjectPortabilityRoot,
  ): string | null;
  selectForCustomer(
    document: Readonly<T>,
    root: CustomerPortabilityRoot,
  ): string | null;
  projectIds(document: Readonly<T>): readonly string[];
  customerIds(document: Readonly<T>): readonly string[];
  ownerReferences(
    document: Readonly<T>,
  ): readonly PortabilityDocumentReference[];
  references(document: Readonly<T>): readonly PortabilityDocumentReference[];
  assetReferences(document: Readonly<T>): readonly PortabilityMediaReference[];
  originalReferences(
    document: Readonly<T>,
  ): readonly PortabilityMediaReference[];
  rewriteIds(document: Readonly<T>, idMap: ExactIdMap): T;
  rebaseDerivedFields(document: Readonly<T>, idMap: ExactIdMap): T;
  validateImport(
    document: Readonly<T>,
    context: PortabilityImportValidationContext,
  ): void;
  verifyDeleted(id: string): PortabilityPostDeleteVerificationQuery;
}

export interface PortabilityParticipantInput<T extends BaseDocument> {
  key: string;
  collection: string;
  currentSchemaVersion: number;
  schema: ZodType<T>;
  migrations?: readonly PortabilityMigration<T>[];
  dependencies?: readonly string[];
  exportModes?: readonly PortabilityExportMode[];
  deletionOrder?: PortabilityDeletionOrder;
  postDeleteVerification?: PortabilityPostDeleteVerificationContract;
  importValidationKey?: string;
  claims?: PortabilityCatalogClaims;
  selectForProject?: PortabilityParticipant<T>["selectForProject"];
  selectForCustomer?: PortabilityParticipant<T>["selectForCustomer"];
  projectIds?: PortabilityParticipant<T>["projectIds"];
  customerIds?: PortabilityParticipant<T>["customerIds"];
  ownerReferences?: PortabilityParticipant<T>["ownerReferences"];
  references?: PortabilityParticipant<T>["references"];
  assetReferences?: PortabilityParticipant<T>["assetReferences"];
  originalReferences?: PortabilityParticipant<T>["originalReferences"];
  rewriteIds?: PortabilityParticipant<T>["rewriteIds"];
  rebaseDerivedFields?: PortabilityParticipant<T>["rebaseDerivedFields"];
  validateImport?: PortabilityParticipant<T>["validateImport"];
}

export interface PortabilityCatalogEntry {
  key: string;
  owner: "participant" | "global" | "internal";
}

export interface PortabilityCatalog {
  collections: readonly PortabilityCatalogEntry[];
  assetRoles: readonly PortabilityCatalogEntry[];
  jobTypes: readonly PortabilityCatalogEntry[];
  scopedWriters: readonly PortabilityCatalogEntry[];
}

export interface PortabilityRegistry {
  readonly participants: readonly PortabilityParticipant[];
  readonly catalog: PortabilityCatalog;
  readonly hash: string;
  forCollection(collection: string): PortabilityParticipant;
}

const globalCollections = Object.freeze([
  "credential_incidents",
  "credential_remediation_audits",
  "job_audit_events",
  "provider_target_change_audits",
  "quota_incidents",
  "scheduler_controls",
  "settings",
  "system_state",
] as const);

const jobCollections = Object.freeze([
  "jobs",
  "job_events",
  "quota_incidents",
  "job_audit_events",
  "provider_target_change_audits",
  "credential_incidents",
  "credential_remediation_audits",
  "scheduler_controls",
] as const);

const foundationCollections = Object.freeze([
  "assets",
  "original_assets",
  "settings",
  "system_state",
] as const);

const portabilityOwnershipCollections = Object.freeze([
  "export_operations",
  "managed_exports",
  "portability_actions",
  "portability_ledger_pages",
  "portability_media_holds",
  "portability_snapshot_entries",
  "portability_snapshots",
] as const);

const portabilityInternalCollections = Object.freeze([
  "deletion_inventories",
  "deletion_operations",
  "deletion_reports",
] as const);

const realCollectionNames = uniqueSorted([
  ...Object.values(libraryCollections),
  ...Object.values(authoringCollections),
  ...Object.values(creativeCollections),
  ...Object.values(layoutCollections),
  ...Object.values(printCollections),
  ...jobCollections,
  ...foundationCollections,
  ...portabilityOwnershipCollections,
  ...portabilityInternalCollections,
]);

const internalAssetRoles = new Set<string>(["import_staging"]);

export const PARTICIPANT_ASSET_ROLES = Object.freeze(
  assetRecordSchema.shape.role.options.filter(
    (role) => !internalAssetRoles.has(role),
  ),
);

export const PARTICIPANT_PROJECT_JOB_TYPES = Object.freeze([
  "character_sheet_finalize",
  "character_sheet_view",
  "human_gate",
  "page_illustration",
  "page_layout",
  "page_prompt",
  "preview_pdf",
  "print_cover",
  "print_interior",
  "print_interior_reuse",
  "print_preflight",
  "review_findings",
  "scene_list",
  "story_plan",
  "story_text",
] as const);

const scopedWriterKeys = Object.freeze([
  "assets.asset-record",
  "assets.original-asset-record",
  "authoring.document",
  "authoring.project-revision",
  "creative.document",
  "jobs.job-record",
  "layout.immutable-document",
  "layout.revisioned-document",
  "library.document",
  "print.immutable-document",
  "print.revisioned-document",
] as const);

export const REAL_PORTABILITY_CATALOG: PortabilityCatalog = freezeCatalog({
  collections: realCollectionNames.map((key) => ({
    key,
    owner: portabilityInternalCollections.includes(
      key as (typeof portabilityInternalCollections)[number],
    )
      ? "internal"
      : globalCollections.includes(key as (typeof globalCollections)[number])
        ? "global"
        : "participant",
  })),
  assetRoles: [
    ...PARTICIPANT_ASSET_ROLES.map((key) => ({
      key,
      owner: "participant" as const,
    })),
    { key: "import_staging", owner: "internal" },
  ],
  jobTypes: PARTICIPANT_PROJECT_JOB_TYPES.map((key) => ({
    key,
    owner: "participant" as const,
  })),
  scopedWriters: [
    ...scopedWriterKeys.map((key) => ({
      key,
      owner: "participant" as const,
    })),
    { key: "layout.persistence-migration", owner: "internal" },
    { key: "portability.deletion-storage", owner: "internal" },
  ],
});

export function definePortabilityParticipant<T extends BaseDocument>(
  input: PortabilityParticipantInput<T>,
): PortabilityParticipant<T> {
  const migrations = freezeMigrations(input.migrations ?? []);
  const importValidationKey = input.importValidationKey ?? "schema_only:v1";
  if (!/^[a-z][a-z0-9_.-]{0,63}:v[1-9][0-9]*$/.test(importValidationKey))
    throw new Error("PORTABILITY_IMPORT_VALIDATION_KEY_INVALID");
  const postDeleteVerification = Object.freeze(
    input.postDeleteVerification ?? {
      kind: "document_id_absent" as const,
      collection: input.collection,
    },
  );
  if (postDeleteVerification.collection !== input.collection)
    throw new Error("PORTABILITY_DELETE_VERIFICATION_COLLECTION_INVALID");
  const claims = Object.freeze({
    assetRoles: Object.freeze([...(input.claims?.assetRoles ?? [])]),
    jobTypes: Object.freeze([...(input.claims?.jobTypes ?? [])]),
    scopedWriters: Object.freeze([...(input.claims?.scopedWriters ?? [])]),
  });
  return Object.freeze({
    ...input,
    migrations,
    dependencies: Object.freeze([...(input.dependencies ?? [])]),
    exportModes: Object.freeze([
      ...(input.exportModes ?? ["project", "customer"]),
    ]),
    deletionOrder: input.deletionOrder ?? "reverse_dependencies",
    postDeleteVerification,
    importValidationKey,
    claims,
    selectForProject: input.selectForProject ?? (() => null),
    selectForCustomer: input.selectForCustomer ?? (() => null),
    projectIds: input.projectIds ?? directIds("projectId"),
    customerIds: input.customerIds ?? directIds("customerId"),
    ownerReferences: input.ownerReferences ?? (() => []),
    references: input.references ?? (() => []),
    assetReferences: input.assetReferences ?? (() => []),
    originalReferences: input.originalReferences ?? (() => []),
    rewriteIds:
      input.rewriteIds ??
      (() => failLater("PORTABILITY_REWRITE_NOT_IMPLEMENTED", input.key)),
    rebaseDerivedFields:
      input.rebaseDerivedFields ??
      (() => failLater("PORTABILITY_REBASE_NOT_IMPLEMENTED", input.key)),
    validateImport: input.validateImport ?? (() => undefined),
    verifyDeleted: (id: string) =>
      Object.freeze({ ...postDeleteVerification, id }),
  });
}

export function createPortabilityRegistry(
  input: readonly PortabilityParticipant[],
  catalog: PortabilityCatalog = REAL_PORTABILITY_CATALOG,
): PortabilityRegistry {
  const participants = topologicalParticipants(input);
  const frozenCatalog = freezeCatalog(catalog);
  assertCatalogComplete(participants, frozenCatalog);
  const byCollection = new Map(
    participants.map((participant) => [participant.collection, participant]),
  );
  const hash = sha256(
    canonicalJson({
      participants: participants.map(registryIdentity),
      catalog: frozenCatalog,
    }),
  );
  return Object.freeze({
    participants,
    catalog: frozenCatalog,
    hash,
    forCollection(collection: string) {
      const participant = byCollection.get(collection);
      if (!participant)
        throw new Error(`PORTABILITY_COLLECTION_UNREGISTERED:${collection}`);
      return participant;
    },
  });
}

export function extendPortabilityCatalog(
  catalog: PortabilityCatalog,
  additions: Partial<PortabilityCatalog>,
): PortabilityCatalog {
  return freezeCatalog({
    collections: [...catalog.collections, ...(additions.collections ?? [])],
    assetRoles: [...catalog.assetRoles, ...(additions.assetRoles ?? [])],
    jobTypes: [...catalog.jobTypes, ...(additions.jobTypes ?? [])],
    scopedWriters: [
      ...catalog.scopedWriters,
      ...(additions.scopedWriters ?? []),
    ],
  });
}

function topologicalParticipants(
  input: readonly PortabilityParticipant[],
): readonly PortabilityParticipant[] {
  const byKey = new Map<string, PortabilityParticipant>();
  const byCollection = new Set<string>();
  for (const participant of input) {
    if (byKey.has(participant.key))
      throw new Error(
        `PORTABILITY_PARTICIPANT_KEY_DUPLICATE:${participant.key}`,
      );
    if (byCollection.has(participant.collection))
      throw new Error(
        `PORTABILITY_PARTICIPANT_COLLECTION_DUPLICATE:${participant.collection}`,
      );
    byKey.set(participant.key, participant);
    byCollection.add(participant.collection);
  }
  assertDependenciesExist(byKey);
  return Object.freeze(sortTopologically(byKey));
}

function assertDependenciesExist(
  participants: ReadonlyMap<string, PortabilityParticipant>,
): void {
  for (const participant of participants.values()) {
    for (const dependency of participant.dependencies) {
      if (!participants.has(dependency))
        throw new Error(`PORTABILITY_DEPENDENCY_UNKNOWN:${dependency}`);
      if (dependency === participant.key)
        throw new Error("PORTABILITY_PARTICIPANT_CYCLE");
    }
  }
}

function sortTopologically(
  participants: ReadonlyMap<string, PortabilityParticipant>,
): PortabilityParticipant[] {
  const remaining = new Map(
    [...participants].map(([key, participant]) => [
      key,
      new Set(participant.dependencies),
    ]),
  );
  const ordered: PortabilityParticipant[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([key]) => key)
      .sort();
    if (ready.length === 0) throw new Error("PORTABILITY_PARTICIPANT_CYCLE");
    for (const key of ready) {
      ordered.push(participants.get(key)!);
      remaining.delete(key);
      for (const dependencies of remaining.values()) dependencies.delete(key);
    }
  }
  return ordered;
}

function assertCatalogComplete(
  participants: readonly PortabilityParticipant[],
  catalog: PortabilityCatalog,
): void {
  assertUniqueCatalog(catalog);
  const collectionClaims = new Map(
    participants.map((participant) => [
      participant.collection,
      participant.key,
    ]),
  );
  assertExpectedClaims("COLLECTION", catalog.collections, collectionClaims);
  assertExpectedClaims(
    "ASSET_ROLE",
    catalog.assetRoles,
    claims(participants, "assetRoles"),
  );
  assertExpectedClaims(
    "JOB_TYPE",
    catalog.jobTypes,
    claims(participants, "jobTypes"),
  );
  assertExpectedClaims(
    "SCOPED_WRITER",
    catalog.scopedWriters,
    claims(participants, "scopedWriters"),
  );
}

function claims(
  participants: readonly PortabilityParticipant[],
  kind: keyof PortabilityCatalogClaims,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const participant of participants) {
    for (const claim of participant.claims[kind]) {
      if (result.has(claim))
        throw new Error(`PORTABILITY_CATALOG_CLAIM_DUPLICATE:${claim}`);
      result.set(claim, participant.key);
    }
  }
  return result;
}

function assertExpectedClaims(
  kind: string,
  entries: readonly PortabilityCatalogEntry[],
  actual: ReadonlyMap<string, string>,
): void {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  for (const [key] of actual) {
    if (byKey.get(key)?.owner !== "participant")
      throw new Error(`PORTABILITY_${kind}_CLAIM_UNKNOWN:${key}`);
  }
  for (const entry of entries) {
    if (entry.owner === "participant" && !actual.has(entry.key))
      throw new Error(`PORTABILITY_${kind}_OMITTED:${entry.key}`);
    if (entry.owner !== "participant" && actual.has(entry.key))
      throw new Error(`PORTABILITY_${kind}_CLAIM_FORBIDDEN:${entry.key}`);
  }
}

function assertUniqueCatalog(catalog: PortabilityCatalog): void {
  const catalogs: readonly (readonly PortabilityCatalogEntry[])[] = [
    catalog.collections,
    catalog.assetRoles,
    catalog.jobTypes,
    catalog.scopedWriters,
  ];
  for (const entries of catalogs) {
    const keys = new Set<string>();
    for (const entry of entries) {
      if (keys.has(entry.key))
        throw new Error(`PORTABILITY_CATALOG_ENTRY_DUPLICATE:${entry.key}`);
      keys.add(entry.key);
    }
  }
}

function registryIdentity(participant: PortabilityParticipant) {
  return {
    key: participant.key,
    collection: participant.collection,
    currentSchemaVersion: participant.currentSchemaVersion,
    migrations: participant.migrations.map(({ from, to }) => ({ from, to })),
    dependencies: participant.dependencies,
    exportModes: participant.exportModes,
    deletionOrder: participant.deletionOrder,
    postDeleteVerification: participant.postDeleteVerification,
    importValidationKey: participant.importValidationKey,
    claims: participant.claims,
  };
}

function freezeMigrations<T extends BaseDocument>(
  input: readonly PortabilityMigration<T>[],
): readonly PortabilityMigration<T>[] {
  const seen = new Set<number>();
  for (const migration of input) {
    if (
      !Number.isSafeInteger(migration.from) ||
      !Number.isSafeInteger(migration.to) ||
      migration.from < 1 ||
      migration.to <= migration.from ||
      seen.has(migration.from)
    )
      throw new Error("PORTABILITY_MIGRATION_DECLARATION_INVALID");
    seen.add(migration.from);
  }
  return Object.freeze([...input]);
}

function freezeCatalog(catalog: PortabilityCatalog): PortabilityCatalog {
  return Object.freeze({
    collections: freezeEntries(catalog.collections),
    assetRoles: freezeEntries(catalog.assetRoles),
    jobTypes: freezeEntries(catalog.jobTypes),
    scopedWriters: freezeEntries(catalog.scopedWriters),
  });
}

function freezeEntries(
  entries: readonly PortabilityCatalogEntry[],
): readonly PortabilityCatalogEntry[] {
  return Object.freeze(
    [...entries]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => Object.freeze({ ...entry })),
  );
}

function directIds<T extends BaseDocument>(field: string) {
  return (document: Readonly<T>): readonly string[] => {
    const value = (document as unknown as Record<string, unknown>)[field];
    return typeof value === "string" ? [value] : [];
  };
}

function failLater(code: string, key: string): never {
  throw new Error(`${code}:${key}`);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
