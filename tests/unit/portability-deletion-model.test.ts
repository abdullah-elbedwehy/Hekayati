import { createHash } from "node:crypto";

import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/contracts/canonical-json.js";
import {
  assertDeletionConfirmationTarget,
  deletionActionOperationId,
  deletionCleanupBoundaryInput,
  deletionConfirmBoundaryInput,
  deletionTargetScope,
  inlineDeletionOperationResult,
} from "../../src/domain/portability/deletion-actions.js";
import {
  deletionBlockerLedgerEntrySchema,
  deletionMediaLedgerEntrySchema,
  deletionVerificationLedgerEntrySchema,
  managedUnlinkLedgerEntrySchema,
} from "../../src/domain/portability/deletion-ledger.js";
import {
  deletionInventorySchema,
  deletionOperationSchema,
  deletionReportSchema,
} from "../../src/domain/portability/deletion-model.js";

const at = "2026-07-16T00:00:00.000Z";

describe("deletion contracts", () => {
  it("accepts immutable inventory and rejects timestamp/blocker-page mismatches", () => {
    const valid = inventory();
    expect(deletionInventorySchema.parse(valid)).toEqual(valid);
    expect(
      deletionInventorySchema.safeParse({
        ...valid,
        updatedAt: "2026-07-16T00:01:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      deletionInventorySchema.safeParse({
        ...valid,
        counts: { ...valid.counts, blockers: 1 },
      }).success,
    ).toBe(false);
    expect(
      deletionInventorySchema.safeParse({ ...valid, blockerPageCount: 1 })
        .success,
    ).toBe(false);
  });

  it("closes operation and report state/timestamp invariants", () => {
    const active = operation();
    expect(deletionOperationSchema.parse(active)).toEqual(active);
    const invalid = [
      { ...active, verifiedAt: at },
      { ...active, reportId: active.id },
      { ...active, state: "cleanup_required", failureCode: null },
      { ...active, state: "unlinking", failureCode: "CLEANUP_FAILED" },
      {
        ...active,
        state: "verified",
        reportId: active.id,
        verifiedAt: at,
        counts: { ...active.counts, failedChecks: 1 },
      },
    ];
    for (const candidate of invalid)
      expect(deletionOperationSchema.safeParse(candidate).success).toBe(false);

    const verified = deletionOperationSchema.parse({
      ...active,
      state: "verified",
      reportId: active.id,
      verifiedAt: at,
    });
    const report = deletionReportSchema.parse({
      id: verified.id,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      operationId: verified.id,
      targetKind: verified.target.kind,
      targetIdHash: verified.target.idHash,
      inventoryId: verified.inventoryId,
      inventoryHash: verified.inventoryHash,
      counts: verified.counts,
      inventoryLedgerRoot: verified.inventoryLedgerRoot,
      unlinkLedgerRoot: verified.unlinkLedgerRoot,
      sharedPreservedLedgerRoot: verified.sharedPreservedLedgerRoot,
      verificationLedgerRoot: verified.verificationLedgerRoot,
      reportDetailLedgerRoot: verified.reportDetailLedgerRoot,
      verifiedAt: at,
      failedChecks: 0,
    });
    expect(report.id).toBe(verified.id);
    expect(
      deletionReportSchema.safeParse({ ...report, operationId: ulid() })
        .success,
    ).toBe(false);
    expect(
      deletionReportSchema.safeParse({
        ...report,
        updatedAt: "2026-07-16T00:01:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("validates media dispositions and managed unlink transitions", () => {
    const media = mediaEntry();
    expect(deletionMediaLedgerEntrySchema.parse(media)).toEqual(media);
    for (const candidate of [
      { ...media, totalRefs: 0 },
      { ...media, expectedRemainingRefs: 2 },
      { ...media, disposition: "unlink_pending" },
    ])
      expect(deletionMediaLedgerEntrySchema.safeParse(candidate).success).toBe(
        false,
      );

    const pending = unlinkEntry();
    expect(managedUnlinkLedgerEntrySchema.parse(pending)).toEqual(pending);
    const invalid = [
      { ...pending, attempts: 1 },
      { ...pending, state: "blocked", failureCode: null },
      { ...pending, state: "unlinked", failureCode: "FAILED" },
      { ...pending, bytes: 1 },
      { ...pending, managedKey: "../escape.png" },
      { ...pending, namespace: "export", bytes: null },
    ];
    for (const candidate of invalid)
      expect(managedUnlinkLedgerEntrySchema.safeParse(candidate).success).toBe(
        false,
      );
    expect(
      managedUnlinkLedgerEntrySchema.safeParse({
        ...pending,
        namespace: "export",
        bytes: 12,
        managedKey: `${pending.mediaId}-${pending.checksum}.zip`,
      }).success,
    ).toBe(true);
  });

  it("validates blocker and verification failure disclosure boundaries", () => {
    expect(
      deletionBlockerLedgerEntrySchema.safeParse({
        entryType: "deletion_blocker",
        code: "DELETION_BLOCKED",
        subjectKind: "asset",
        subjectId: "safe-id",
      }).success,
    ).toBe(true);
    const verification = {
      entryType: "deletion_verification" as const,
      checkKind: "scope_absent" as const,
      subjectKind: "project",
      subjectId: ulid(),
      expectedHash: hash("expected"),
      expectedCount: 0,
      actualCount: 0,
      passed: true,
      failureCode: null,
    };
    expect(deletionVerificationLedgerEntrySchema.parse(verification)).toEqual(
      verification,
    );
    expect(
      deletionVerificationLedgerEntrySchema.safeParse({
        ...verification,
        failureCode: "FAILED",
      }).success,
    ).toBe(false);
    expect(
      deletionVerificationLedgerEntrySchema.safeParse({
        ...verification,
        passed: false,
        failureCode: null,
      }).success,
    ).toBe(false);
  });

  it("builds stable FR-160 action requests and closed target scopes", () => {
    const current = deletionOperationSchema.parse(operation());
    const inv = deletionInventorySchema.parse(inventory());
    const confirm = deletionConfirmBoundaryInput(
      "confirm-key",
      inv,
      "not_applicable",
    );
    const retry = deletionCleanupBoundaryInput("retry-key", current);
    expect(confirm.action).toBe("deletion_confirm");
    expect(confirm.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(confirm.input).toMatchObject({
      hashes: { displayNameHash: inv.target.displayNameHash },
      flags: { finalConfirmation: true },
    });
    expect(retry.action).toBe("deletion_cleanup_retry");
    expect(deletionTargetScope(inv)).toEqual({
      kind: "project",
      id: inv.target.id,
      projectId: inv.target.id,
      customerId: inv.target.customerId,
    });
    const customer = {
      ...inv,
      target: {
        ...inv.target,
        kind: "customer" as const,
        id: inv.target.customerId,
      },
    };
    expect(deletionTargetScope(customer).kind).toBe("customer");
    expect(inlineDeletionOperationResult(current)).toMatchObject({
      kind: "inline",
      entityIds: [current.id],
      flags: { verified: false },
    });
    expect(
      deletionActionOperationId(inlineDeletionOperationResult(current)),
    ).toBe(current.id);
    expect(() =>
      deletionActionOperationId({ kind: "hash", resultHash: hash("result") }),
    ).toThrowError("DELETION_ACTION_RESULT_INVALID");
    expect(() =>
      assertDeletionConfirmationTarget(
        {
          target: { kind: "project", id: ulid() },
          inventoryHash: inv.inventoryHash,
          targetRevisionHash: inv.target.revisionHash,
          displayName: "display",
          finalConfirmation: true,
          customerCharacterDecision: "not_applicable",
        },
        inv,
      ),
    ).toThrowError("DELETION_CONFIRMATION_MISMATCH");
    expect(() =>
      assertDeletionConfirmationTarget(
        {
          target: { kind: "customer", id: customer.target.id },
          inventoryHash: customer.inventoryHash,
          targetRevisionHash: customer.target.revisionHash,
          displayName: "display",
          finalConfirmation: true,
          customerCharacterDecision: "keep_pinned",
        },
        customer,
      ),
    ).toThrowError("DELETION_KEEP_PINNED_ROUTE_ARCHIVE_EXPORT");
  });
});

function inventory() {
  const projectId = ulid();
  const customerId = ulid();
  return {
    id: ulid(),
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    target: {
      kind: "project" as const,
      id: projectId,
      customerId,
      idHash: hash(projectId),
      revisionHash: hash("revision"),
      displayNameHash: canonicalHash("display"),
    },
    participantRegistryHash: hash("registry"),
    counts: counts(),
    inventoryPageCount: 0,
    inventoryLedgerRoot: hash("inventory-root"),
    blockerPageCount: 0,
    blockerLedgerRoot: hash("blocker-root"),
    inventoryHash: hash("inventory"),
  };
}

function operation() {
  const inv = inventory();
  return {
    id: ulid(),
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    target: inv.target,
    inventoryId: inv.id,
    inventoryHash: inv.inventoryHash,
    idempotencyKey: "delete-key",
    requestHash: hash("request"),
    state: "unlinking" as const,
    lockId: ulid(),
    lockRevision: 1,
    counts: {
      ...counts(),
      canceledJobs: 0,
      deletedDocuments: 0,
      unlinkItems: 0,
      failedChecks: 0,
    },
    inventoryLedgerRoot: inv.inventoryLedgerRoot,
    blockerLedgerRoot: inv.blockerLedgerRoot,
    unlinkLedgerRoot: hash("unlink-root"),
    sharedPreservedLedgerRoot: hash("shared-root"),
    verificationLedgerRoot: hash("verification-root"),
    reportDetailLedgerRoot: hash("report-root"),
    reportId: null,
    failureCode: null,
    verifiedAt: null,
  };
}

function counts() {
  return {
    documents: 0,
    jobs: 0,
    exports: 0,
    media: 0,
    blockers: 0,
    sharedPreserved: 0,
    preservedDocuments: 0,
  };
}

function mediaEntry() {
  return {
    entryType: "deletion_media" as const,
    namespace: "asset" as const,
    mediaId: ulid(),
    checksum: hash("media"),
    ownedRefs: 1,
    referencedRefs: 2,
    totalRefs: 2,
    expectedRemainingRefs: 1,
    disposition: "shared_reference_preserved" as const,
  };
}

function unlinkEntry() {
  const checksum = hash("unlink");
  return {
    entryType: "managed_unlink" as const,
    namespace: "asset" as const,
    mediaId: ulid(),
    checksum,
    managedKey: `${checksum.slice(0, 2)}/${checksum}.png`,
    bytes: null,
    state: "pending" as const,
    attempts: 0,
    failureCode: null,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
