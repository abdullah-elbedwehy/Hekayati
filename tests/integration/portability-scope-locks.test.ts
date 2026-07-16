import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { CapturedAttemptLedger } from "../../src/domain/portability/operation-ledgers.js";
import {
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
} from "../../src/domain/portability/repositories.js";
import {
  ScopeAdmissionService,
  operationScopeCapability,
  type ScopeLockAcquisition,
} from "../../src/domain/portability/scope-locks.js";
import { portabilityScopeLockSchema } from "../../src/domain/portability/schemas.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("hierarchical portability scope admission", () => {
  it("admits only the exact captured attempt while an export drains", async () => {
    const fixture = await scopeFixture();
    const customerId = ulid();
    const projectId = ulid();
    const operationId = ulid();
    const jobId = ulid();
    const ledger = fixture.captured.write(operationId, [{ jobId, attempt: 2 }]);
    const scope = projectScope(customerId, projectId);
    const lock = fixture.admission.acquire({
      operationId,
      scope,
      mode: "export_snapshot",
      phase: "draining",
      capturedAttemptLedgerRoot: ledger.rootHash,
      capturedAttemptCount: ledger.entryCount,
    });

    fixture.store.transactionImmediate(() => {
      const forged = { ...lock, operationId: ulid() };
      expect(() =>
        fixture.locks.updateInTransaction(forged, {
          ...forged,
          phase: "snapshot",
          revision: 1,
          updatedAt: "2026-07-16T10:01:00.000Z",
        }),
      ).toThrow("PORTABILITY_LOCK_REVISION_CONFLICT");
    });

    expect(() =>
      fixture.admission.assertAdmittedInTransaction({
        scope,
        purpose: "domain_mutation",
      }),
    ).toThrow("PORTABILITY_TRANSACTION_REQUIRED");

    fixture.store.transactionImmediate(() => {
      fixture.admission.assertAdmittedInTransaction({
        scope: projectScope(ulid(), ulid()),
        purpose: "domain_mutation",
      });
      fixture.admission.assertAdmittedInTransaction({
        scope,
        purpose: "scope_pause",
        operation: operationScopeCapability({
          operationId,
          purpose: "scope_pause",
          mode: "export_snapshot",
          phase: "draining",
        }),
      });
      fixture.admission.assertAdmittedInTransaction({
        scope,
        purpose: "scheduler_run",
        job: { jobId, attempt: 2 },
      });
      fixture.admission.assertAdmittedInTransaction({
        scope,
        purpose: "scheduler_commit",
        job: { jobId, attempt: 2 },
      });
      expect(() =>
        fixture.admission.assertAdmittedInTransaction({
          scope,
          purpose: "scheduler_commit",
          job: { jobId, attempt: 1 },
        }),
      ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
      expect(() =>
        fixture.admission.assertAdmittedInTransaction({
          scope,
          purpose: "scheduler_enqueue",
        }),
      ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
    });

    const snapshot = fixture.admission.transition(
      lock.id,
      operationId,
      0,
      "snapshot",
    );
    fixture.store.transactionImmediate(() => {
      expect(() =>
        fixture.admission.assertAdmittedInTransaction({
          scope,
          purpose: "scope_pause",
          operation: operationScopeCapability({
            operationId,
            purpose: "scope_pause",
            mode: "export_snapshot",
            phase: "draining",
          }),
        }),
      ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
      fixture.admission.assertAdmittedInTransaction({
        scope,
        purpose: "snapshot_freeze",
        operation: operationScopeCapability({
          operationId,
          purpose: "snapshot_freeze",
          mode: "export_snapshot",
          phase: "snapshot",
        }),
      });
      expect(() =>
        fixture.admission.assertAdmittedInTransaction({
          scope,
          purpose: "scheduler_commit",
          job: { jobId, attempt: 2 },
        }),
      ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
    });
    const releasing = fixture.admission.transition(
      lock.id,
      operationId,
      snapshot.revision,
      "releasing",
    );
    fixture.admission.release(lock.id, operationId, releasing.revision);
    expect(fixture.locks.list()).toEqual([]);
  });

  it("rejects operation capabilities outside their exact purpose, phase, mode, and owner", async () => {
    const fixture = await scopeFixture();
    const operationId = ulid();
    const scope = projectScope(ulid(), ulid());
    const root = fixture.captured.write(operationId, []);
    const lock = fixture.admission.acquire({
      operationId,
      scope,
      mode: "replace_import",
      phase: "draining",
      capturedAttemptLedgerRoot: root.rootHash,
      capturedAttemptCount: 0,
    });
    const drainingPause = operationScopeCapability({
      operationId,
      purpose: "scope_pause",
      mode: "replace_import",
      phase: "draining",
    });

    fixture.store.transactionImmediate(() => {
      fixture.admission.assertAdmittedInTransaction({
        scope,
        purpose: "scope_pause",
        operation: drainingPause,
      });
      for (const operation of [
        operationScopeCapability({
          operationId: ulid(),
          purpose: "scope_pause",
          mode: "replace_import",
          phase: "draining",
        }),
        operationScopeCapability({
          operationId,
          purpose: "scope_pause",
          mode: "permanent_delete",
          phase: "draining",
        }),
        operationScopeCapability({
          operationId,
          purpose: "scope_pause",
          mode: "replace_import",
          phase: "exclusive",
        }),
      ]) {
        expect(() =>
          fixture.admission.assertAdmittedInTransaction({
            scope,
            purpose: "scope_pause",
            operation,
          }),
        ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
      }
      expect(() =>
        fixture.admission.assertAdmittedInTransaction({
          scope,
          purpose: "scope_cancel",
          operation: drainingPause,
        }),
      ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
    });

    const exclusive = fixture.admission.transition(
      lock.id,
      operationId,
      lock.revision,
      "exclusive",
    );
    fixture.store.transactionImmediate(() => {
      fixture.admission.assertAdmittedInTransaction({
        scope,
        purpose: "domain_mutation",
        operation: operationScopeCapability({
          operationId,
          purpose: "domain_mutation",
          mode: "replace_import",
          phase: "exclusive",
        }),
      });
      expect(() =>
        fixture.admission.assertAdmittedInTransaction({
          scope,
          purpose: "scope_pause",
          operation: drainingPause,
        }),
      ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
    });
    const releasing = fixture.admission.transition(
      lock.id,
      operationId,
      exclusive.revision,
      "releasing",
    );
    fixture.admission.release(lock.id, operationId, releasing.revision);
    fixture.store.transactionImmediate(() => {
      expect(() =>
        fixture.admission.assertAdmittedInTransaction({
          scope,
          purpose: "domain_mutation",
          operation: operationScopeCapability({
            operationId,
            purpose: "domain_mutation",
            mode: "replace_import",
            phase: "exclusive",
          }),
        }),
      ).toThrow("PORTABILITY_SCOPE_ADMISSION_DENIED");
    });
  });

  it("enforces customer/project and template-catalog overlap rules", async () => {
    const fixture = await scopeFixture();
    const customerId = ulid();
    const projectId = ulid();
    const customerOperation = ulid();
    const customerRoot = fixture.captured.write(customerOperation, []);
    const customerLock = fixture.admission.acquire({
      operationId: customerOperation,
      scope: customerScope(customerId),
      mode: "permanent_delete",
      phase: "draining",
      capturedAttemptLedgerRoot: customerRoot.rootHash,
      capturedAttemptCount: 0,
    });

    const projectOperation = ulid();
    const projectRoot = fixture.captured.write(projectOperation, []);
    expect(() =>
      fixture.admission.acquire({
        operationId: projectOperation,
        scope: projectScope(customerId, projectId),
        mode: "permanent_delete",
        phase: "draining",
        capturedAttemptLedgerRoot: projectRoot.rootHash,
        capturedAttemptCount: 0,
      }),
    ).toThrow("PORTABILITY_SCOPE_BUSY");
    expect(
      fixture.admission.overlapping(projectScope(customerId, projectId)),
    ).toEqual([customerLock]);
    expect(fixture.admission.overlapping(projectScope(ulid(), ulid()))).toEqual(
      [],
    );

    const exclusive = fixture.admission.transition(
      customerLock.id,
      customerOperation,
      0,
      "exclusive",
    );
    expect(() =>
      fixture.admission.transition(
        customerLock.id,
        customerOperation,
        exclusive.revision,
        "draining",
      ),
    ).toThrow("PORTABILITY_LOCK_STATE_INVALID");
  });

  it("acquires non-overlapping resources in canonical order and replays exactly", async () => {
    const fixture = await scopeFixture();
    const operationId = ulid();
    const root = fixture.captured.write(operationId, []);
    const common = {
      operationId,
      mode: "import_commit" as const,
      phase: "exclusive" as const,
      capturedAttemptLedgerRoot: root.rootHash,
      capturedAttemptCount: 0,
    };
    const project = {
      ...common,
      scope: projectScope(ulid(), ulid()),
    } satisfies ScopeLockAcquisition;
    const templates = {
      ...common,
      scope: { kind: "template_catalog", id: "template_catalog" } as const,
    } satisfies ScopeLockAcquisition;

    const acquired = fixture.admission.acquireMany([project, templates]);
    expect(acquired.map((lock) => lock.scope.kind)).toEqual([
      "template_catalog",
      "project",
    ]);
    expect(fixture.admission.acquireMany([templates, project])).toEqual(
      acquired,
    );

    expect(() =>
      fixture.admission.acquireMany([
        project,
        {
          ...common,
          scope: customerScope(project.scope.customerId),
        },
      ]),
    ).toThrow("PORTABILITY_SCOPE_REQUEST_CONFLICT");
  });

  it("rejects an uncommitted capture root and any lease-like lock field", async () => {
    const fixture = await scopeFixture();
    const operationId = ulid();
    expect(() =>
      fixture.admission.acquire({
        operationId,
        scope: projectScope(ulid(), ulid()),
        mode: "export_snapshot",
        phase: "draining",
        capturedAttemptLedgerRoot: "0".repeat(64),
        capturedAttemptCount: 0,
      }),
    ).toThrow("PORTABILITY_CAPTURE_LEDGER_MISMATCH");

    const now = "2026-07-16T10:00:00.000Z";
    expect(
      portabilityScopeLockSchema.safeParse({
        id: ulid(),
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        operationId,
        scope: projectScope(ulid(), ulid()),
        mode: "export_snapshot",
        phase: "draining",
        revision: 0,
        capturedAttemptLedgerRoot: "0".repeat(64),
        capturedAttemptCount: 0,
        acquiredAt: now,
        expiresAt: now,
      }).success,
    ).toBe(false);
    expect(
      portabilityScopeLockSchema.safeParse({
        id: ulid(),
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        operationId,
        scope: { kind: "template_catalog", id: "template_catalog" },
        mode: "permanent_delete",
        phase: "draining",
        revision: 0,
        capturedAttemptLedgerRoot: "0".repeat(64),
        capturedAttemptCount: 0,
        acquiredAt: now,
      }).success,
    ).toBe(false);
  });
});

function projectScope(customerId: string, projectId: string) {
  return { kind: "project" as const, id: projectId, customerId, projectId };
}

function customerScope(customerId: string) {
  return { kind: "customer" as const, id: customerId, customerId };
}

async function scopeFixture() {
  const directory = await temporaryDirectory("hekayati-scope-locks-");
  const store = new DocumentStore(join(directory.path, "scope-locks.db"));
  const ledgers = new PortabilityLedgerRepository(store);
  const locks = new PortabilityScopeLockRepository(store);
  const captured = new CapturedAttemptLedger(store, ledgers, {
    nowIso: () => "2026-07-16T10:00:00.000Z",
    idFactory: ulid,
  });
  const admission = new ScopeAdmissionService(store, locks, ledgers, {
    nowIso: () => "2026-07-16T10:00:00.000Z",
    idFactory: ulid,
  });
  cleanups.push(async () => {
    store.close();
    await directory.cleanup();
  });
  return { store, ledgers, locks, captured, admission };
}
