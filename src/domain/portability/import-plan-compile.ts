import { createHash } from "node:crypto";

import { canonicalJson } from "../../contracts/canonical-json.js";
import type { BaseDocument } from "../repository/document-store.js";
import { assertNoUnmappedArchiveIds, lookupExactId } from "./id-map.js";
import type { ImportIdAllocation } from "./import-plan-allocation.js";
import type {
  ImportAuthorizationLedgerEntry,
  ImportRebaseLedgerEntry,
  ImportWriteLedgerEntry,
  PreparedMediaIntentLedgerEntry,
} from "./import-ledger.js";
import type { ImportPlanRequest } from "./import-plan-model.js";
import {
  sanitizeSelectedImportDocument,
  type ImportPlanSourceBundle,
  type SelectedImportBundle,
} from "./import-plan-selection.js";
import {
  canonicalImportMediaMetadata,
  type ImportPlanTargetReader,
} from "./import-plan-target.js";
import type {
  PortabilityRegistry,
  PortabilityValidatedMediaFacts,
} from "./participants.js";
import type { PortabilityLedgerEntry } from "./schemas.js";

export interface PlannedImportDocument {
  readonly collection: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly disposition: "create" | "replace";
  readonly document: Readonly<BaseDocument>;
  readonly sourceDocumentHash: string;
  readonly changedFieldsHash: string;
}

export interface CompiledImportPlan {
  readonly documents: readonly PlannedImportDocument[];
  readonly writes: readonly ImportWriteLedgerEntry[];
  readonly rebases: readonly ImportRebaseLedgerEntry[];
  readonly releases: readonly PortabilityLedgerEntry[];
  readonly preparedMedia: readonly PreparedMediaIntentLedgerEntry[];
  readonly authorizations: readonly ImportAuthorizationLedgerEntry[];
  readonly approvalsPreserved: number;
  readonly approvalsDemoted: number;
  readonly jobsPaused: number;
  readonly sanitizationFactsHash: string;
}

type CompileInput = Parameters<typeof compileImportPlan>[0];
type DocumentCompileInput = CompileInput & {
  selectedKeys: ReadonlySet<string>;
  mediaCounts: ReadonlyMap<string, number>;
  preserveApproval: boolean;
};
type SelectedDocument = SelectedImportBundle["documents"][number];

export function compileImportPlan(input: {
  readonly request: ImportPlanRequest;
  readonly source: ImportPlanSourceBundle;
  readonly selected: SelectedImportBundle;
  readonly allocation: ImportIdAllocation;
  readonly registry: PortabilityRegistry;
  readonly target: ImportPlanTargetReader;
}): CompiledImportPlan {
  const selectedKeys = new Set(
    input.selected.documents.map((item) => `${item.collection}:${item.id}`),
  );
  const mediaCounts = mediaReferenceCounts(input.selected, input.registry);
  const preserveApproval = approvalPreservationProven(input);
  const documents = compileDocuments({
    ...input,
    selectedKeys,
    mediaCounts,
    preserveApproval,
  });
  validateCompiledGraph(input, documents);
  const authorization = compileAuthorizations(
    input,
    documents,
    preserveApproval,
  );
  const media = compileMediaIntents(input, mediaCounts);
  return Object.freeze({
    documents: Object.freeze(documents),
    writes: Object.freeze(documents.map(writeEntry)),
    rebases: Object.freeze(documents.map(rebaseEntry)),
    releases: Object.freeze(media.releases),
    preparedMedia: Object.freeze(media.prepared),
    authorizations: Object.freeze(authorization.entries),
    approvalsPreserved: authorization.preserved,
    approvalsDemoted: authorization.demoted,
    jobsPaused: countPausedJobs(documents),
    sanitizationFactsHash: sanitizationFactsHash(input, preserveApproval),
  });
}

function countPausedJobs(documents: readonly PlannedImportDocument[]): number {
  return documents.filter(
    (item) =>
      item.collection === "jobs" &&
      (item.document as Readonly<Record<string, unknown>>).state === "paused",
  ).length;
}

function sanitizationFactsHash(
  input: CompileInput,
  preserveApproval: boolean,
): string {
  return hash({
    policy: "HekayatiImportSanitization/v1",
    mode: input.request.mode,
    localConsentAuthority: true,
    projectPaused: projectMode(input.request.mode),
    approval: preserveApproval ? "preserved" : "demoted_or_absent",
    selectiveCollections: input.selected.documents.map(
      (item) => item.collection,
    ),
  });
}

function compileDocuments(
  input: DocumentCompileInput,
): PlannedImportDocument[] {
  const order = new Map(
    input.registry.participants.map((participant, index) => [
      participant.collection,
      index,
    ]),
  );
  const result: PlannedImportDocument[] = [];
  const sorted = [...input.selected.documents].sort(
    (left, right) =>
      (order.get(left.collection) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.collection) ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
  );
  for (const item of sorted) {
    const compiled = compileDocument(input, item);
    if (compiled) result.push(compiled);
  }
  return result;
}

function compileDocument(
  input: DocumentCompileInput,
  item: SelectedDocument,
): PlannedImportDocument | null {
  const mapping = documentMapping(input, item);
  const replace = replacesRootProject(input, item);
  if (
    !replace &&
    (mapping.disposition === "mapped_existing" ||
      mapping.disposition === "deduplicated")
  )
    return null;
  const sanitized = sanitizeSelectedImportDocument(
    input.request.mode,
    input.selectedKeys,
    item.collection,
    item.document,
  );
  const authorized = applyImportAuthorityPolicy({
    collection: item.collection,
    document: sanitized,
    request: input.request,
    preserveApproval: input.preserveApproval,
    mediaRefCount:
      input.mediaCounts.get(`${mediaNamespace(item.collection)}:${item.id}`) ??
      1,
  });
  const participant = input.registry.forCollection(item.collection);
  const rewritten = participant.rewriteIds(authorized, input.allocation.idMap);
  const parsed = participant.schema.parse(
    participant.rebaseDerivedFields(rewritten, input.allocation.idMap),
  );
  assertNoUnmappedArchiveIds(parsed, input.allocation.idMap);
  return Object.freeze({
    collection: item.collection,
    sourceId: item.id,
    targetId: mapping.targetId,
    disposition: replace ? "replace" : "create",
    document: Object.freeze(parsed),
    sourceDocumentHash: item.normalizedSha256,
    changedFieldsHash: hash(changedTopLevelFields(item.document, parsed)),
  });
}

function documentMapping(input: DocumentCompileInput, item: SelectedDocument) {
  const mapping = input.allocation.mappings.find(
    (entry) =>
      entry.namespace === namespaceForCollection(item.collection) &&
      entry.sourceId === item.id,
  );
  if (!mapping) throw new Error("IMPORT_PLAN_DOCUMENT_MAPPING_MISSING");
  return mapping;
}

function replacesRootProject(
  input: DocumentCompileInput,
  item: SelectedDocument,
): boolean {
  return (
    input.request.mode === "replace_existing" &&
    item.collection === "projects" &&
    item.id === input.source.root.projectId
  );
}

function applyImportAuthorityPolicy(input: {
  collection: string;
  document: BaseDocument;
  request: ImportPlanRequest;
  preserveApproval: boolean;
  mediaRefCount: number;
}): BaseDocument {
  const result = clone(input.document) as BaseDocument &
    Record<string, unknown>;
  if (
    input.collection === "customers" &&
    input.request.customerResolution?.kind === "create_from_archive" &&
    Object.hasOwn(result, "consent")
  )
    result.consent = null;
  if (input.collection === "projects") {
    if (Object.hasOwn(result, "paused")) result.paused = true;
    if (
      !input.preserveApproval &&
      Object.hasOwn(result, "currentContentApprovalId")
    ) {
      result.currentContentApprovalId = null;
      if (result.status === "approved" || result.status === "print_ready")
        result.status = "preview_ready";
    }
    if (
      input.request.mode === "replace_existing" &&
      Object.hasOwn(result, "revision")
    )
      result.revision = (input.request.replaceTarget?.projectRevision ?? 0) + 1;
  }
  if (
    (input.collection === "assets" || input.collection === "original_assets") &&
    Object.hasOwn(result, "refCount")
  )
    result.refCount = Math.max(1, input.mediaRefCount);
  return result;
}

function validateCompiledGraph(
  input: Parameters<typeof compileImportPlan>[0],
  documents: readonly PlannedImportDocument[],
): void {
  const byKey = new Map(
    documents.map((item) => [
      `${item.collection}:${item.targetId}`,
      item.document,
    ]),
  );
  const media = remappedMedia(input);
  const context = {
    document: (collection: string, id: string) =>
      byKey.get(`${collection}:${id}`) ?? input.target.document(collection, id),
    media: (namespace: "asset" | "original", id: string) =>
      media.get(`${namespace}:${id}`) ?? null,
  };
  for (const item of documents) {
    const participant = input.registry.forCollection(item.collection);
    for (const reference of [
      ...participant.ownerReferences(item.document),
      ...participant.references(item.document),
    ]) {
      if (
        reference.required !== false &&
        !context.document(reference.collection, reference.id)
      )
        throw new Error("IMPORT_PLAN_REBASED_CLOSURE_INVALID");
    }
    for (const reference of participant.assetReferences(item.document))
      if (!context.media("asset", reference.id))
        throw new Error("IMPORT_PLAN_REBASED_MEDIA_CLOSURE_INVALID");
    for (const reference of participant.originalReferences(item.document))
      if (!context.media("original", reference.id))
        throw new Error("IMPORT_PLAN_REBASED_MEDIA_CLOSURE_INVALID");
    participant.validateImport(item.document, context);
  }
}

function compileMediaIntents(
  input: CompileInput,
  counts: ReadonlyMap<string, number>,
): {
  prepared: PreparedMediaIntentLedgerEntry[];
  releases: PortabilityLedgerEntry[];
} {
  const documents = new Map(
    input.selected.documents.map((item) => [
      `${item.collection}:${item.id}`,
      item.document,
    ]),
  );
  const prepared = input.selected.media.map((facts) =>
    preparedMediaIntent(input, documents, facts),
  );
  const releases = input.selected.media.flatMap((facts) =>
    retainedMediaRelease(input, counts, facts),
  );
  return { prepared, releases };
}

function preparedMediaIntent(
  input: CompileInput,
  documents: ReadonlyMap<string, Readonly<BaseDocument>>,
  facts: PortabilityValidatedMediaFacts,
): PreparedMediaIntentLedgerEntry {
  const mapping = mappingFor(input.allocation, facts.namespace, facts.id);
  const collection = facts.namespace === "asset" ? "assets" : "original_assets";
  return {
    entryType: "prepared_media_intent",
    namespace: facts.namespace,
    sourceId: facts.id,
    targetId: mapping.targetId,
    bytes: facts.bytes,
    sha256: facts.sha256,
    metadataHash: canonicalImportMediaMetadata({
      facts,
      document: documents.get(`${collection}:${facts.id}`) ?? null,
    }),
    disposition:
      mapping.disposition === "deduplicated"
        ? "retain_existing"
        : "prepare_new",
  };
}

function retainedMediaRelease(
  input: CompileInput,
  counts: ReadonlyMap<string, number>,
  facts: PortabilityValidatedMediaFacts,
): PortabilityLedgerEntry[] {
  const mapping = mappingFor(input.allocation, facts.namespace, facts.id);
  if (mapping.disposition !== "deduplicated") return [];
  return [
    {
      entryType: "reference_delta",
      namespace: facts.namespace,
      mediaId: mapping.targetId,
      role: facts.role,
      bytes: facts.bytes,
      sha256: facts.sha256,
      delta: counts.get(`${facts.namespace}:${facts.id}`) ?? 1,
      disposition: "retained",
    },
  ];
}

function compileAuthorizations(
  input: CompileInput,
  documents: readonly PlannedImportDocument[],
  preserveApproval: boolean,
): {
  entries: ImportAuthorizationLedgerEntry[];
  preserved: number;
  demoted: number;
} {
  const customerEntries = compileCustomerAuthorizations(input);
  const approval = compileApprovalAuthorization(
    input,
    documents,
    preserveApproval,
  );
  return {
    entries: approval ? [...customerEntries, approval] : customerEntries,
    preserved: approval?.disposition === "preserved" ? 1 : 0,
    demoted: approval?.disposition === "demoted" ? 1 : 0,
  };
}

function compileCustomerAuthorizations(
  input: CompileInput,
): ImportAuthorizationLedgerEntry[] {
  const sourceCustomer = sourceDocument(
    input,
    "customers",
    input.source.root.customerId,
  );
  const targetCustomerId = lookupExactId(
    input.allocation.idMap,
    "customers",
    input.source.root.customerId,
  );
  if (!sourceCustomer || !targetCustomerId) return [];
  const resolution = input.request.customerResolution;
  const mapped = resolution?.kind === "map_existing_same_customer";
  const targetCustomer = mapped
    ? input.target.document("customers", targetCustomerId)
    : null;
  const entries: ImportAuthorizationLedgerEntry[] = [
    {
      entryType: "import_authorization",
      authorizationKind: "local_consent",
      sourceId: sourceCustomer.id,
      targetId: targetCustomerId,
      disposition: mapped ? "local_authority" : "historical",
      sourceHash: nullableHash(field(sourceCustomer, "consent")),
      targetHash: nullableHash(
        targetCustomer ? field(targetCustomer, "consent") : null,
      ),
      reasonCode: mapped
        ? "LOCAL_CONSENT_AUTHORITATIVE"
        : "LOCAL_RECONSENT_REQUIRED",
    },
  ];
  if (mapped)
    entries.push({
      entryType: "import_authorization",
      authorizationKind: "customer_attestation",
      sourceId: sourceCustomer.id,
      targetId: targetCustomerId,
      disposition: "local_authority",
      sourceHash: hash(input.request.customerResolution),
      targetHash: resolution.targetCustomerRevisionHash,
      reasonCode: "SAME_CUSTOMER_ATTESTED",
    });
  return entries;
}

function compileApprovalAuthorization(
  input: CompileInput,
  documents: readonly PlannedImportDocument[],
  preserveApproval: boolean,
): ImportAuthorizationLedgerEntry | null {
  const project = sourceDocument(
    input,
    "projects",
    input.source.root.projectId,
  );
  const approvalId = project
    ? field(project, "currentContentApprovalId")
    : null;
  if (typeof approvalId !== "string") return null;
  const targetId = lookupExactId(
    input.allocation.idMap,
    "book_approval_cycles",
    approvalId,
  );
  if (!targetId) return null;
  const sourceCycle = sourceDocument(input, "book_approval_cycles", approvalId);
  const targetCycle = documents.find(
    (item) =>
      item.collection === "book_approval_cycles" && item.targetId === targetId,
  )?.document;
  return {
    entryType: "import_authorization",
    authorizationKind: "book_approval",
    sourceId: approvalId,
    targetId,
    disposition: preserveApproval ? "preserved" : "demoted",
    sourceHash: nullableHash(
      sourceCycle ? field(sourceCycle, "customerContentHash") : null,
    ),
    targetHash: nullableHash(
      targetCycle ? field(targetCycle, "customerContentHash") : null,
    ),
    reasonCode: preserveApproval
      ? "SEMANTIC_APPROVAL_PRESERVED"
      : "FRESH_APPROVAL_REQUIRED",
  };
}

function approvalPreservationProven(
  input: Parameters<typeof compileImportPlan>[0],
): boolean {
  if (
    input.request.approvalPolicy !== "preserve_if_proven" ||
    !projectMode(input.request.mode)
  )
    return false;
  const project = sourceDocument(
    input,
    "projects",
    input.source.root.projectId,
  );
  const approvalId = project
    ? field(project, "currentContentApprovalId")
    : null;
  if (typeof approvalId !== "string") return false;
  const cycle = sourceDocument(input, "book_approval_cycles", approvalId);
  return cycle !== null && field(cycle, "state") === "approved";
}

function mediaReferenceCounts(
  selected: SelectedImportBundle,
  registry: PortabilityRegistry,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of selected.documents) {
    const participant = registry.forCollection(item.collection);
    for (const ref of participant.assetReferences(item.document))
      increment(counts, `asset:${ref.id}`);
    for (const ref of participant.originalReferences(item.document))
      increment(counts, `original:${ref.id}`);
  }
  return counts;
}

function remappedMedia(
  input: Parameters<typeof compileImportPlan>[0],
): ReadonlyMap<string, PortabilityValidatedMediaFacts> {
  const result = new Map<string, PortabilityValidatedMediaFacts>();
  for (const facts of input.selected.media) {
    const targetId = mappingFor(
      input.allocation,
      facts.namespace,
      facts.id,
    ).targetId;
    result.set(`${facts.namespace}:${targetId}`, { ...facts, id: targetId });
  }
  return result;
}

function writeEntry(document: PlannedImportDocument): ImportWriteLedgerEntry {
  return {
    entryType: "import_write",
    collection: document.collection,
    sourceId: document.sourceId,
    targetId: document.targetId,
    documentHash: hash(document.document),
    disposition: document.disposition,
  };
}

function rebaseEntry(document: PlannedImportDocument): ImportRebaseLedgerEntry {
  return {
    entryType: "import_rebase",
    collection: document.collection,
    sourceId: document.sourceId,
    targetId: document.targetId,
    sourceDocumentHash: document.sourceDocumentHash,
    rebasedDocumentHash: hash(document.document),
    changedFieldsHash: document.changedFieldsHash,
  };
}

function mappingFor(
  allocation: ImportIdAllocation,
  namespace: string,
  sourceId: string,
) {
  const mapping = allocation.mappings.find(
    (item) => item.namespace === namespace && item.sourceId === sourceId,
  );
  if (!mapping) throw new Error("IMPORT_PLAN_MEDIA_MAPPING_MISSING");
  return mapping;
}

function sourceDocument(
  input: Parameters<typeof compileImportPlan>[0],
  collection: string,
  id: string,
): Readonly<BaseDocument> | null {
  return (
    input.selected.documents.find(
      (item) => item.collection === collection && item.id === id,
    )?.document ?? null
  );
}

function nullableHash(value: unknown): string | null {
  return value === null || value === undefined ? null : hash(value);
}

function field(document: Readonly<BaseDocument>, name: string): unknown {
  return (document as Readonly<Record<string, unknown>>)[name];
}

function increment(values: Map<string, number>, key: string): void {
  values.set(key, (values.get(key) ?? 0) + 1);
}

function changedTopLevelFields(
  source: Readonly<BaseDocument>,
  target: Readonly<BaseDocument>,
): string[] {
  const keys = new Set([...Object.keys(source), ...Object.keys(target)]);
  return [...keys]
    .filter(
      (key) =>
        canonicalJson(
          (source as Readonly<Record<string, unknown>>)[key] ?? null,
        ) !==
        canonicalJson(
          (target as Readonly<Record<string, unknown>>)[key] ?? null,
        ),
    )
    .sort();
}

function namespaceForCollection(collection: string): string {
  if (collection === "assets") return "asset";
  if (collection === "original_assets") return "original";
  return collection;
}

function mediaNamespace(collection: string): string {
  return namespaceForCollection(collection);
}

function projectMode(mode: ImportPlanRequest["mode"]): boolean {
  return mode === "as_new_project" || mode === "replace_existing";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
