import type {
  BaseDocument,
  DocumentStore,
} from "../repository/document-store.js";
import {
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
  assertPortabilityTransaction,
} from "./repositories.js";
import {
  createPortabilityRegistry,
  type PortabilityRegistry,
} from "./participants.js";
import { realPortabilityParticipants } from "./real-participants.js";
import {
  ScopeAdmissionService,
  operationScopeCapability,
  type OperationScopeCapability,
} from "./scope-locks.js";
import type {
  PortabilityScope,
  PortabilityScopeLockMode,
  PortabilityScopeLockPhase,
} from "./schemas.js";

export const DOMAIN_MUTATION_WRITER_KEYS = Object.freeze([
  "authoring.document",
  "authoring.project-revision",
  "creative.document",
  "layout.immutable-document",
  "layout.revisioned-document",
  "library.document",
  "print.immutable-document",
  "print.revisioned-document",
] as const);

export type DomainMutationWriterKey =
  | (typeof DOMAIN_MUTATION_WRITER_KEYS)[number]
  | "portability.deletion-storage"
  | "portability.import-storage";
export type DomainMutationKind = "insert" | "update" | "delete";

export type OperationOwnedMutationPurpose =
  "import_commit" | "replace_commit" | "deletion_confirm";

export interface OperationOwnedMutationInput {
  readonly operationId: string;
  readonly purpose: OperationOwnedMutationPurpose;
  readonly phase: PortabilityScopeLockPhase;
  readonly writer: DomainMutationWriterKey;
  readonly collection: string;
  readonly mutation: DomainMutationKind;
}

export interface OperationOwnedMutationContext extends OperationOwnedMutationInput {
  readonly scopeCapability: OperationScopeCapability;
}

export interface DomainMutationAdmissionRequest {
  writer: DomainMutationWriterKey;
  collection: string;
  mutation: DomainMutationKind;
  before?: Readonly<BaseDocument> | null;
  after?: Readonly<BaseDocument> | null;
  operation?: OperationOwnedMutationContext;
}

export type DomainMutationAdmissionErrorCode =
  | "DOMAIN_MUTATION_WRITER_CATALOG_MISMATCH"
  | "DOMAIN_MUTATION_OPERATION_CONTEXT_INVALID"
  | "DOMAIN_MUTATION_OWNER_NOT_FOUND"
  | "DOMAIN_MUTATION_PROJECT_NOT_FOUND"
  | "DOMAIN_MUTATION_CUSTOMER_NOT_FOUND"
  | "DOMAIN_MUTATION_OWNER_CONFLICT";

export class DomainMutationAdmissionError extends Error {
  readonly name = "DomainMutationAdmissionError";

  constructor(readonly code: DomainMutationAdmissionErrorCode) {
    super(code);
  }
}

const registry = createPortabilityRegistry(realPortabilityParticipants);
const admissions = new WeakMap<DocumentStore, DomainMutationAdmission>();

export function domainMutationAdmission(
  store: DocumentStore,
): DomainMutationAdmission {
  const existing = admissions.get(store);
  if (existing) return existing;
  const created = new DomainMutationAdmission(store, registry);
  admissions.set(store, created);
  return created;
}

export function operationOwnedMutation(
  input: OperationOwnedMutationInput,
): OperationOwnedMutationContext {
  const policy = operationMutationPolicies[input.purpose];
  if (
    !input.operationId ||
    !policy ||
    input.phase !== policy.phase ||
    !policy.mutations.has(input.mutation)
  )
    throw new DomainMutationAdmissionError(
      "DOMAIN_MUTATION_OPERATION_CONTEXT_INVALID",
    );
  return Object.freeze({
    ...input,
    scopeCapability: operationScopeCapability({
      operationId: input.operationId,
      purpose: "domain_mutation",
      mode: policy.mode,
      phase: input.phase,
    }),
  });
}

export class DomainMutationAdmission {
  private readonly scopeAdmission: ScopeAdmissionService;
  private readonly locks: PortabilityScopeLockRepository;

  constructor(
    private readonly store: DocumentStore,
    private readonly participantRegistry: PortabilityRegistry,
    options: { allowExtendedParticipantWriters?: boolean } = {},
  ) {
    assertWriterCatalogComplete(
      participantRegistry,
      options.allowExtendedParticipantWriters === true,
    );
    this.locks = new PortabilityScopeLockRepository(store);
    this.scopeAdmission = new ScopeAdmissionService(
      store,
      this.locks,
      new PortabilityLedgerRepository(store),
    );
  }

  assertInTransaction(input: DomainMutationAdmissionRequest): void {
    assertPortabilityTransaction(this.store);
    assertOperationContext(input);
    if (this.locks.list().length === 0 && !input.operation) return;
    const resolver = new MutationScopeResolver(
      this.store,
      this.participantRegistry,
    );
    const scopes = resolver.resolve(input.collection, [
      input.before ?? null,
      input.after ?? null,
    ]);
    for (const scope of scopes)
      this.scopeAdmission.assertAdmittedInTransaction({
        scope,
        purpose: "domain_mutation",
        ...(input.operation
          ? { operation: input.operation.scopeCapability }
          : {}),
      });
  }
}

interface OperationMutationPolicy {
  readonly mode: PortabilityScopeLockMode;
  readonly phase: PortabilityScopeLockPhase;
  readonly mutations: ReadonlySet<DomainMutationKind>;
}

const operationMutationPolicies: Readonly<
  Record<OperationOwnedMutationPurpose, OperationMutationPolicy>
> = Object.freeze({
  import_commit: Object.freeze({
    mode: "import_commit",
    phase: "exclusive",
    mutations: new Set<DomainMutationKind>(["insert"]),
  }),
  replace_commit: Object.freeze({
    mode: "replace_import",
    phase: "exclusive",
    mutations: new Set<DomainMutationKind>(["insert", "update", "delete"]),
  }),
  deletion_confirm: Object.freeze({
    mode: "permanent_delete",
    phase: "exclusive",
    mutations: new Set<DomainMutationKind>(["delete"]),
  }),
});

class MutationScopeResolver {
  private readonly memo = new Map<string, ResolvedOwners>();

  constructor(
    private readonly store: DocumentStore,
    private readonly registry: PortabilityRegistry,
  ) {}

  resolve(
    collection: string,
    documents: readonly (Readonly<BaseDocument> | null)[],
  ): PortabilityScope[] {
    const owners = documents.reduce<ResolvedOwners>(
      (result, document) =>
        document
          ? mergeOwners(result, this.resolveDocument(collection, document))
          : result,
      emptyOwners(),
    );
    return canonicalScopes(owners);
  }

  private resolveDocument(
    collection: string,
    value: Readonly<BaseDocument>,
  ): ResolvedOwners {
    const participant = this.registry.forCollection(collection);
    const document = participant.schema.parse(value);
    const memoKey = `${collection}\0${JSON.stringify(document)}`;
    const existing = this.memo.get(memoKey);
    if (existing) return existing;
    this.memo.set(memoKey, emptyOwners());
    let owners = directOwners(collection, document, participant);
    for (const reference of participant.ownerReferences(document)) {
      const owner = this.readOwner(reference.collection, reference.id);
      if (!owner) {
        if (reference.required !== false)
          fail("DOMAIN_MUTATION_OWNER_NOT_FOUND");
        continue;
      }
      owners = mergeOwners(
        owners,
        this.resolveDocument(reference.collection, owner),
      );
    }
    owners = this.resolveExactRoots(collection, document, owners);
    this.memo.set(memoKey, owners);
    return owners;
  }

  private resolveExactRoots(
    collection: string,
    document: BaseDocument,
    owners: ResolvedOwners,
  ): ResolvedOwners {
    const projects = new Map<string, string>();
    for (const projectId of owners.projectIds)
      projects.set(
        projectId,
        this.projectCustomerId(collection, document, projectId),
      );
    for (const customerId of owners.customerIds)
      this.assertCustomerExists(collection, document, customerId);
    return { ...owners, projects };
  }

  private projectCustomerId(
    collection: string,
    document: BaseDocument,
    projectId: string,
  ): string {
    const project =
      collection === "projects" && document.id === projectId
        ? document
        : this.readOwner("projects", projectId);
    if (!project) fail("DOMAIN_MUTATION_PROJECT_NOT_FOUND");
    const participant = this.registry.forCollection("projects");
    const customerIds = participant.customerIds(
      participant.schema.parse(project),
    );
    if (customerIds.length !== 1) fail("DOMAIN_MUTATION_OWNER_CONFLICT");
    this.assertCustomerExists(collection, document, customerIds[0]);
    return customerIds[0];
  }

  private assertCustomerExists(
    collection: string,
    document: BaseDocument,
    customerId: string,
  ): void {
    if (collection === "customers" && document.id === customerId) return;
    if (!this.readOwner("customers", customerId))
      fail("DOMAIN_MUTATION_CUSTOMER_NOT_FOUND");
  }

  private readOwner(collection: string, id: string): BaseDocument | null {
    const row = this.store.database
      .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
      .get(collection, id) as { doc: string } | undefined;
    if (!row) return null;
    return this.registry
      .forCollection(collection)
      .schema.parse(JSON.parse(row.doc));
  }
}

interface ResolvedOwners {
  projectIds: Set<string>;
  customerIds: Set<string>;
  projects: Map<string, string>;
  templateCatalog: boolean;
}

function directOwners(
  collection: string,
  document: BaseDocument,
  participant: ReturnType<PortabilityRegistry["forCollection"]>,
): ResolvedOwners {
  const projectIds = new Set(participant.projectIds(document));
  const customerIds = new Set(participant.customerIds(document));
  if (collection === "projects") projectIds.add(document.id);
  if (collection === "customers") customerIds.add(document.id);
  return {
    projectIds,
    customerIds,
    projects: new Map(),
    templateCatalog: participant.exportModes.includes("templates_only"),
  };
}

function canonicalScopes(owners: ResolvedOwners): PortabilityScope[] {
  const scopes: PortabilityScope[] = [...owners.projects]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([projectId, customerId]) => ({
      kind: "project" as const,
      id: projectId,
      projectId,
      customerId,
    }));
  const representedCustomers = new Set(owners.projects.values());
  for (const customerId of [...owners.customerIds].sort()) {
    if (representedCustomers.has(customerId)) continue;
    scopes.push({
      kind: "customer",
      id: customerId,
      customerId,
    });
  }
  if (owners.templateCatalog)
    scopes.push({ kind: "template_catalog", id: "template_catalog" });
  return scopes;
}

function mergeOwners(
  left: ResolvedOwners,
  right: ResolvedOwners,
): ResolvedOwners {
  return {
    projectIds: new Set([...left.projectIds, ...right.projectIds]),
    customerIds: new Set([...left.customerIds, ...right.customerIds]),
    projects: new Map([...left.projects, ...right.projects]),
    templateCatalog: left.templateCatalog || right.templateCatalog,
  };
}

function emptyOwners(): ResolvedOwners {
  return {
    projectIds: new Set(),
    customerIds: new Set(),
    projects: new Map(),
    templateCatalog: false,
  };
}

function assertOperationContext(input: DomainMutationAdmissionRequest): void {
  const operation = input.operation;
  if (!operation) return;
  if (
    !operation.operationId ||
    !operation.scopeCapability ||
    operation.scopeCapability.operationId !== operation.operationId ||
    operation.scopeCapability.purpose !== "domain_mutation" ||
    operation.scopeCapability.phase !== operation.phase ||
    operation.writer !== input.writer ||
    operation.collection !== input.collection ||
    operation.mutation !== input.mutation
  )
    fail("DOMAIN_MUTATION_OPERATION_CONTEXT_INVALID");
}

function assertWriterCatalogComplete(
  registry: PortabilityRegistry,
  allowExtended: boolean,
): void {
  const actual = registry.catalog.scopedWriters
    .filter(
      (entry) =>
        entry.owner === "participant" &&
        !entry.key.startsWith("assets.") &&
        entry.key !== "jobs.job-record",
    )
    .map((entry) => entry.key)
    .sort();
  const expected = [...DOMAIN_MUTATION_WRITER_KEYS].sort();
  const complete = allowExtended
    ? expected.every((key) => actual.includes(key))
    : actual.join("\0") === expected.join("\0");
  if (!complete) fail("DOMAIN_MUTATION_WRITER_CATALOG_MISMATCH");
}

function fail(code: DomainMutationAdmissionErrorCode): never {
  throw new DomainMutationAdmissionError(code);
}
