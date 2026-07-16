import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import { LayoutRepositories } from "../../src/domain/layout/repositories.js";
import { LibraryRepositories } from "../../src/domain/library/repositories.js";
import {
  DOMAIN_MUTATION_WRITER_KEYS,
  operationOwnedMutation,
  type DomainMutationWriterKey,
} from "../../src/domain/portability/domain-mutation-admission.js";
import { CapturedAttemptLedger } from "../../src/domain/portability/operation-ledgers.js";
import {
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
} from "../../src/domain/portability/repositories.js";
import { ScopeAdmissionService } from "../../src/domain/portability/scope-locks.js";
import type { PortabilityScope } from "../../src/domain/portability/schemas.js";
import { PrintRepositories } from "../../src/domain/print/repositories.js";
import type { PrintRun } from "../../src/domain/print/schemas.js";
import type { BaseDocument } from "../../src/domain/repository/document-store.js";
import {
  createPortabilityFixture,
  type PortabilityFixture,
} from "../helpers/portability-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
const insertedAt = "2026-07-16T00:30:00.000Z";
const updatedAt = "2026-07-16T00:31:00.000Z";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("domain mutation scope admission", () => {
  it.each(["project", "customer"] as const)(
    "fences every registered writer under a %s lock and admits unrelated scope",
    async (lockKind) => {
      const fixture = await trackedFixture();
      const harness = buildHarness(fixture);
      const boundary = acquireLock(fixture, lockKind);

      expect(harness.cases.map((item) => item.writer)).toEqual(
        DOMAIN_MUTATION_WRITER_KEYS,
      );
      for (const mutationCase of harness.cases) {
        mutationCase.assertBlocked(lockKind);
        mutationCase.assertUnrelatedContinues(lockKind);
      }

      if (lockKind === "project")
        assertExportOperationCannotBypass(fixture, harness, boundary);
    },
  );

  it("admits only an exact operation-owned write in its exclusive commit phase", async () => {
    const fixture = await trackedFixture();
    const harness = buildHarness(fixture);
    const boundary = acquireProjectLock(fixture, "replace_import");
    assertExactReplaceCommitCapability(harness, boundary);
  });
});

type LockKind = "project" | "customer";

interface MutationCase {
  writer: DomainMutationWriterKey;
  assertBlocked(lockKind: LockKind): void;
  assertUnrelatedContinues(lockKind: LockKind): void;
}

interface MutableCaseInput<T extends BaseDocument> {
  writer: DomainMutationWriterKey;
  locked: T;
  lockedInsert: T;
  unrelatedInsert: T;
  get(id: string): T | null;
  insert(document: T): T;
  update(document: T): T;
  delete(id: string): boolean;
  changed(document: T): T;
}

type ImmutableCaseInput<T extends BaseDocument> = Omit<
  MutableCaseInput<T>,
  "update" | "changed"
>;

interface MutationHarness {
  cases: MutationCase[];
  authoring: AuthoringRepositories;
  lockedProject: NonNullable<
    ReturnType<AuthoringRepositories["projects"]["get"]>
  >;
}

function buildHarness(fixture: PortabilityFixture): MutationHarness {
  const library = new LibraryRepositories(fixture.store);
  const authoring = new AuthoringRepositories(fixture.store);
  const creative = new CreativeRepositories(fixture.store);
  const layout = new LayoutRepositories(fixture.store);
  const print = new PrintRepositories(fixture.store);
  const selected = selectedDocuments(
    fixture,
    library,
    authoring,
    creative,
    layout,
    print,
  );
  const owners = seedOwnerDocuments(fixture, creative, print, selected);
  return {
    authoring,
    lockedProject: selected.project,
    cases: [
      authoringDocumentCase(fixture, authoring, selected),
      projectRevisionCase(fixture, authoring, selected.project),
      creativeDocumentCase(fixture, creative, selected.page),
      layoutImmutableCase(layout, selected.layoutVersion, owners),
      layoutRevisionedCase(layout, selected.layoutHead, owners),
      libraryDocumentCase(fixture, library, selected.family),
      printImmutableCase(fixture, print, selected.artifact, owners),
      printRevisionedCase(fixture, print, selected.run),
    ],
  };
}

function selectedDocuments(
  fixture: PortabilityFixture,
  library: LibraryRepositories,
  authoring: AuthoringRepositories,
  creative: CreativeRepositories,
  layout: LayoutRepositories,
  print: PrintRepositories,
) {
  const project = required(authoring.projects.get(fixture.scope.projectId));
  const family = required(
    library.families.list().find((item) => item.id === fixture.scope.familyId),
  );
  const projectVersion = required(
    authoring.projectVersions
      .list()
      .find((item) => item.projectId === project.id),
  );
  const page = required(
    creative.pages.list().find((item) => item.projectId === project.id),
  );
  const layoutHead = required(layout.pageLayoutHeads.get(page.id));
  const layoutVersion = required(
    layout.layoutVersions.get(layoutHead.currentLayoutVersionId),
  );
  const run = required(print.runs.get(fixture.records.printRunId));
  const artifact = required(
    print.artifacts.list().find((item) => item.projectId === project.id),
  );
  return {
    family,
    project,
    projectVersion,
    page,
    layoutHead,
    layoutVersion,
    run,
    artifact,
  };
}

function seedOwnerDocuments(
  fixture: PortabilityFixture,
  creative: CreativeRepositories,
  print: PrintRepositories,
  selected: ReturnType<typeof selectedDocuments>,
) {
  const lockedPage = cloneForInsert(selected.page, {
    projectId: fixture.scope.projectId,
  });
  const unrelatedPage = cloneForInsert(selected.page, {
    projectId: fixture.unrelatedScope.projectId,
  });
  creative.pages.insert(lockedPage);
  creative.pages.insert(unrelatedPage);
  const unrelatedRun = cloneRun(selected.run, fixture.unrelatedScope);
  print.runs.insert(unrelatedRun);
  return { lockedPage, unrelatedPage, unrelatedRun };
}

function authoringDocumentCase(
  fixture: PortabilityFixture,
  repositories: AuthoringRepositories,
  selected: ReturnType<typeof selectedDocuments>,
): MutationCase {
  const repository = repositories.projectVersions;
  return mutableCase({
    writer: "authoring.document",
    locked: selected.projectVersion,
    lockedInsert: cloneForInsert(selected.projectVersion),
    unrelatedInsert: cloneForInsert(selected.projectVersion, {
      projectId: fixture.unrelatedScope.projectId,
    }),
    get: (id) => repository.get(id),
    insert: (document) => repository.insert(document),
    update: (document) => repository.update(document),
    delete: (id) => repository.delete(id),
    changed: touch,
  });
}

function projectRevisionCase(
  fixture: PortabilityFixture,
  repositories: AuthoringRepositories,
  lockedProject: ReturnType<typeof selectedDocuments>["project"],
): MutationCase {
  const sameCustomer = cloneForInsert(lockedProject, { revision: 0 });
  const differentCustomer = cloneForInsert(lockedProject, {
    customerId: fixture.unrelatedScope.customerId,
    familyId: fixture.unrelatedScope.familyId,
    revision: 0,
  });
  return {
    writer: "authoring.project-revision",
    assertBlocked(lockKind) {
      if (lockKind === "customer") {
        expectDenied(() => repositories.projects.insert(sameCustomer));
        expect(repositories.projects.get(sameCustomer.id)).toBeNull();
      }
      expectDenied(() =>
        repositories.projects.update(advanceRevision(lockedProject)),
      );
      expectDenied(() => repositories.projects.delete(lockedProject.id));
      expect(repositories.projects.get(lockedProject.id)).toEqual(
        lockedProject,
      );
    },
    assertUnrelatedContinues(lockKind) {
      const document =
        lockKind === "project" ? sameCustomer : differentCustomer;
      expect(repositories.projects.insert(document)).toEqual(document);
      const advanced = advanceRevision(document);
      expect(repositories.projects.update(advanced)).toEqual(advanced);
      expect(repositories.projects.delete(document.id)).toBe(true);
    },
  };
}

function creativeDocumentCase(
  fixture: PortabilityFixture,
  repositories: CreativeRepositories,
  page: ReturnType<typeof selectedDocuments>["page"],
): MutationCase {
  const repository = repositories.pages;
  return mutableCase({
    writer: "creative.document",
    locked: page,
    lockedInsert: cloneForInsert(page),
    unrelatedInsert: cloneForInsert(page, {
      projectId: fixture.unrelatedScope.projectId,
    }),
    get: (id) => repository.get(id),
    insert: (document) => repository.insert(document),
    update: (document) => repository.update(document),
    delete: (id) => repository.delete(id),
    changed: touch,
  });
}

function layoutImmutableCase(
  repositories: LayoutRepositories,
  layoutVersion: ReturnType<typeof selectedDocuments>["layoutVersion"],
  owners: ReturnType<typeof seedOwnerDocuments>,
): MutationCase {
  const repository = repositories.layoutVersions;
  return immutableCase({
    writer: "layout.immutable-document",
    locked: layoutVersion,
    lockedInsert: cloneForInsert(layoutVersion),
    unrelatedInsert: cloneForInsert(layoutVersion, {
      pageId: owners.unrelatedPage.id,
    }),
    get: (id) => repository.get(id),
    insert: (document) => repository.insert(document),
    delete: (id) => repository.delete(id),
  });
}

function layoutRevisionedCase(
  repositories: LayoutRepositories,
  layoutHead: ReturnType<typeof selectedDocuments>["layoutHead"],
  owners: ReturnType<typeof seedOwnerDocuments>,
): MutationCase {
  const repository = repositories.pageLayoutHeads;
  const headFor = (pageId: string) =>
    cloneForInsert(layoutHead, { id: pageId, pageId, revision: 0 });
  return mutableCase({
    writer: "layout.revisioned-document",
    locked: layoutHead,
    lockedInsert: headFor(owners.lockedPage.id),
    unrelatedInsert: headFor(owners.unrelatedPage.id),
    get: (id) => repository.get(id),
    insert: (document) => repository.insert(document),
    update: (document) => repository.update(document.revision - 1, document),
    delete: (id) => repository.delete(id),
    changed: advanceRevision,
  });
}

function libraryDocumentCase(
  fixture: PortabilityFixture,
  repositories: LibraryRepositories,
  family: ReturnType<typeof selectedDocuments>["family"],
): MutationCase {
  const repository = repositories.families;
  return mutableCase({
    writer: "library.document",
    locked: family,
    lockedInsert: cloneForInsert(family),
    unrelatedInsert: cloneForInsert(family, {
      customerId: fixture.unrelatedScope.customerId,
    }),
    get: (id) => repository.get(id),
    insert: (document) => repository.insert(document, "DUPLICATE_ENTITY_ID"),
    update: (document) => repository.update(document),
    delete: (id) => repository.delete(id),
    changed: touch,
  });
}

function printImmutableCase(
  fixture: PortabilityFixture,
  repositories: PrintRepositories,
  artifact: ReturnType<typeof selectedDocuments>["artifact"],
  owners: ReturnType<typeof seedOwnerDocuments>,
): MutationCase {
  const repository = repositories.artifacts;
  return immutableCase({
    writer: "print.immutable-document",
    locked: artifact,
    lockedInsert: cloneForInsert(artifact),
    unrelatedInsert: cloneForInsert(artifact, {
      projectId: fixture.unrelatedScope.projectId,
      runId: owners.unrelatedRun.id,
    }),
    get: (id) => repository.get(id),
    insert: (document) => repository.insert(document),
    delete: (id) => repository.delete(id),
  });
}

function printRevisionedCase(
  fixture: PortabilityFixture,
  repositories: PrintRepositories,
  run: ReturnType<typeof selectedDocuments>["run"],
): MutationCase {
  const repository = repositories.runs;
  return mutableCase({
    writer: "print.revisioned-document",
    locked: run,
    lockedInsert: cloneRun(run, fixture.scope),
    unrelatedInsert: cloneRun(run, fixture.unrelatedScope),
    get: (id) => repository.get(id),
    insert: (document) => repository.insert(document),
    update: (document) => repository.update(document.revision - 1, document),
    delete: (id) => repository.delete(id),
    changed: advanceRevision,
  });
}

function mutableCase<T extends BaseDocument>(
  input: MutableCaseInput<T>,
): MutationCase {
  return {
    writer: input.writer,
    assertBlocked() {
      expectDenied(() => input.insert(input.lockedInsert));
      expect(input.get(input.lockedInsert.id)).toBeNull();
      expectDenied(() => input.update(input.changed(input.locked)));
      expectDenied(() => input.delete(input.locked.id));
      expect(input.get(input.locked.id)).toEqual(input.locked);
    },
    assertUnrelatedContinues() {
      expect(input.insert(input.unrelatedInsert)).toEqual(
        input.unrelatedInsert,
      );
      const advanced = input.changed(input.unrelatedInsert);
      expect(input.update(advanced)).toEqual(advanced);
      expect(input.delete(advanced.id)).toBe(true);
      expect(input.get(advanced.id)).toBeNull();
    },
  };
}

function immutableCase<T extends BaseDocument>(
  input: ImmutableCaseInput<T>,
): MutationCase {
  return {
    writer: input.writer,
    assertBlocked() {
      expectDenied(() => input.insert(input.lockedInsert));
      expect(input.get(input.lockedInsert.id)).toBeNull();
      expectDenied(() => input.delete(input.locked.id));
      expect(input.get(input.locked.id)).toEqual(input.locked);
    },
    assertUnrelatedContinues() {
      expect(input.insert(input.unrelatedInsert)).toEqual(
        input.unrelatedInsert,
      );
      expect(input.delete(input.unrelatedInsert.id)).toBe(true);
      expect(input.get(input.unrelatedInsert.id)).toBeNull();
    },
  };
}

function acquireLock(fixture: PortabilityFixture, kind: LockKind) {
  const ledgers = new PortabilityLedgerRepository(fixture.store);
  const locks = new PortabilityScopeLockRepository(fixture.store);
  const captured = new CapturedAttemptLedger(fixture.store, ledgers);
  const admission = new ScopeAdmissionService(fixture.store, locks, ledgers);
  const operationId = ulid();
  const root = captured.write(operationId, []);
  const scope: PortabilityScope =
    kind === "project"
      ? {
          kind,
          id: fixture.scope.projectId,
          projectId: fixture.scope.projectId,
          customerId: fixture.scope.customerId,
        }
      : {
          kind,
          id: fixture.scope.customerId,
          customerId: fixture.scope.customerId,
        };
  const lock = admission.acquire({
    operationId,
    scope,
    mode: kind === "project" ? "export_snapshot" : "permanent_delete",
    phase: "draining",
    capturedAttemptLedgerRoot: root.rootHash,
    capturedAttemptCount: root.entryCount,
  });
  return { operationId, lock, admission };
}

function acquireProjectLock(
  fixture: PortabilityFixture,
  mode: "export_snapshot" | "replace_import",
) {
  const ledgers = new PortabilityLedgerRepository(fixture.store);
  const locks = new PortabilityScopeLockRepository(fixture.store);
  const captured = new CapturedAttemptLedger(fixture.store, ledgers);
  const admission = new ScopeAdmissionService(fixture.store, locks, ledgers);
  const operationId = ulid();
  const root = captured.write(operationId, []);
  const lock = admission.acquire({
    operationId,
    scope: {
      kind: "project",
      id: fixture.scope.projectId,
      projectId: fixture.scope.projectId,
      customerId: fixture.scope.customerId,
    },
    mode,
    phase: "draining",
    capturedAttemptLedgerRoot: root.rootHash,
    capturedAttemptCount: root.entryCount,
  });
  return { operationId, lock, admission };
}

function assertExactReplaceCommitCapability(
  harness: MutationHarness,
  boundary: ReturnType<typeof acquireProjectLock>,
): void {
  const projects = harness.authoring.projects;
  const context = replaceUpdateContext(boundary.operationId);
  const changed = advanceRevision(harness.lockedProject);
  expect(() =>
    projects.update(changed, operationOwnedMutation(context)),
  ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
  boundary.admission.transition(
    boundary.lock.id,
    boundary.operationId,
    boundary.lock.revision,
    "exclusive",
  );
  expect(projects.update(changed, operationOwnedMutation(context))).toEqual(
    changed,
  );
  assertTargetMismatchRejected(harness, context, changed);
  assertCapabilityPolicyRejected(context);
  releaseBoundary(boundary);
  expect(() =>
    projects.update(advanceRevision(changed), operationOwnedMutation(context)),
  ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
}

function replaceUpdateContext(operationId: string) {
  return {
    operationId,
    purpose: "replace_commit" as const,
    phase: "exclusive" as const,
    writer: "authoring.project-revision" as const,
    collection: "projects",
    mutation: "update" as const,
  };
}

function assertTargetMismatchRejected(
  harness: MutationHarness,
  context: ReturnType<typeof replaceUpdateContext>,
  changed: MutationHarness["lockedProject"],
): void {
  const projects = harness.authoring.projects;
  for (const mismatch of [
    { ...context, writer: "authoring.document" as const },
    { ...context, collection: "project_versions" },
    { ...context, mutation: "delete" as const },
  ])
    expect(() =>
      projects.update(
        advanceRevision(changed),
        operationOwnedMutation(mismatch),
      ),
    ).toThrow("DOMAIN_MUTATION_OPERATION_CONTEXT_INVALID");
  expect(() =>
    projects.update(
      advanceRevision(changed),
      operationOwnedMutation({ ...context, operationId: ulid() }),
    ),
  ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
  expect(projects.get(changed.id)).toEqual(changed);
}

function assertCapabilityPolicyRejected(
  context: ReturnType<typeof replaceUpdateContext>,
): void {
  for (const invalid of [
    { ...context, phase: "draining" as const },
    {
      ...context,
      purpose: "import_commit" as const,
      mutation: "update" as const,
    },
    {
      ...context,
      purpose: "deletion_confirm" as const,
      mutation: "update" as const,
    },
  ])
    expect(() => operationOwnedMutation(invalid)).toThrow(
      "DOMAIN_MUTATION_OPERATION_CONTEXT_INVALID",
    );
}

function releaseBoundary(
  boundary: ReturnType<typeof acquireProjectLock>,
): void {
  const current = boundary.admission.overlapping(boundary.lock.scope)[0];
  const releasing = boundary.admission.transition(
    current.id,
    boundary.operationId,
    current.revision,
    "releasing",
  );
  boundary.admission.release(
    releasing.id,
    boundary.operationId,
    releasing.revision,
  );
}

function assertExportOperationCannotBypass(
  fixture: PortabilityFixture,
  harness: MutationHarness,
  boundary: ReturnType<typeof acquireLock>,
): void {
  const projects = harness.authoring.projects;
  const changed = advanceRevision(harness.lockedProject);
  const context = {
    operationId: boundary.operationId,
    purpose: "replace_commit" as const,
    phase: "exclusive" as const,
    writer: "authoring.project-revision" as const,
    collection: "projects",
    mutation: "update" as const,
  };

  expect(() =>
    projects.update(changed, operationOwnedMutation(context)),
  ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
  boundary.admission.transition(
    boundary.lock.id,
    boundary.operationId,
    boundary.lock.revision,
    "snapshot",
  );
  expect(() =>
    projects.update(changed, operationOwnedMutation(context)),
  ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
  expect(projects.get(changed.id)).toEqual(harness.lockedProject);
  expect(fixture.store.isHealthy()).toBe(true);
}

function cloneRun(run: PrintRun, scope: PortabilityFixture["scope"]): PrintRun {
  return cloneForInsert(run, {
    revision: 0,
    projectId: scope.projectId,
    customerId: scope.customerId,
    familyId: scope.familyId,
    idempotencyKey: `admission-${ulid()}`,
  });
}

function cloneForInsert<T extends BaseDocument>(
  document: T,
  patch: Partial<T> = {},
): T {
  return {
    ...document,
    id: ulid(),
    createdAt: insertedAt,
    updatedAt: insertedAt,
    ...patch,
  };
}

function touch<T extends BaseDocument>(document: T): T {
  return { ...document, updatedAt };
}

function advanceRevision<T extends BaseDocument & { revision: number }>(
  document: T,
): T {
  return { ...document, revision: document.revision + 1, updatedAt };
}

function expectDenied(operation: () => unknown): void {
  expect(operation).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("DOMAIN_MUTATION_TEST_FIXTURE_MISSING");
  return value;
}

async function trackedFixture(): Promise<PortabilityFixture> {
  const fixture = await createPortabilityFixture();
  cleanups.push(fixture.cleanup);
  return fixture;
}
