import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { resolveDataPaths } from "../../src/config/paths.js";
import {
  ApprovedBookSnapshotReader,
  BookApprovalService,
} from "../../src/domain/layout/approvals.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  addPreviewBundle,
  approvalActionInput,
  createApprovalFixture,
  customerContentHash,
} from "../helpers/layout-approval-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("book approval and immutable content authorization", () => {
  it("approves once, replays safely, and reads the same authorization through observation drift", async () => {
    const fixture = await harness();
    const bundle = addPreviewBundle(fixture);
    const service = new BookApprovalService(fixture.store, fixture.scheduler);

    const sentInput = approvalActionInput(
      fixture,
      bundle,
      "preview_sent",
      "send-preview-v1",
    );
    const sent = service.act(sentInput);
    const replay = service.act(sentInput);
    expect(sent).toMatchObject({
      replayed: false,
      approvalState: "preview_sent",
      gateState: "waiting_review",
      currentContentApprovalId: null,
    });
    expect(replay).toEqual({ ...sent, replayed: true });

    const approved = service.act(
      approvalActionInput(fixture, bundle, "approved", "approve-preview-v1"),
    );
    expect(approved).toMatchObject({
      approvalState: "approved",
      gateState: "succeeded",
      currentContentApprovalId: bundle.cycle.id,
      projectStatus: "approved",
    });

    const integrity = mutableIntegrity(fixture.assetId, fixture.assetChecksum);
    const reader = new ApprovedBookSnapshotReader(
      fixture.store,
      fixture.scheduler,
      integrity.port,
      { resolveCustomerContentHash: () => customerContentHash },
    );
    const first = await reader.read(fixture.projectId);
    expect(await reader.read(fixture.projectId)).toEqual(first);

    const project = fixture.authoring.projects.get(fixture.projectId)!;
    fixture.authoring.projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: "2026-07-15T03:00:00.000Z",
      bookVersion: project.bookVersion + 1,
      currentPreviewOutputId: ulid(),
      currentPreviewCycleId: ulid(),
    });
    const afterObservationDrift = await reader.read(fixture.projectId);
    expect(afterObservationDrift.contentAuthorizationHash).toBe(
      first.contentAuthorizationHash,
    );
    expect(afterObservationDrift.observations).not.toEqual(first.observations);

    integrity.setStatus("corrupt");
    await expect(reader.read(fixture.projectId)).rejects.toThrowError(
      "APPROVED_SNAPSHOT_INTEGRITY_FAILED",
    );
    integrity.setStatus("healthy");
    expect(
      (await reader.read(fixture.projectId)).contentAuthorizationHash,
    ).toBe(first.contentAuthorizationHash);
    fixture.store.close();
  });

  it("preserves approval through a same-content preview, then clears it on scoped changes", async () => {
    const fixture = await harness();
    const original = addPreviewBundle(fixture);
    const service = new BookApprovalService(fixture.store, fixture.scheduler);
    service.act(
      approvalActionInput(fixture, original, "preview_sent", "send-original"),
    );
    service.act(
      approvalActionInput(fixture, original, "approved", "approve-original"),
    );

    const successor = addPreviewBundle(fixture);
    service.act(
      approvalActionInput(fixture, successor, "preview_sent", "send-successor"),
    );
    expect(fixture.authoring.projects.get(fixture.projectId)).toMatchObject({
      status: "approved",
      currentContentApprovalId: original.cycle.id,
    });

    const pageId = successor.output.orderedInteriorPages[0].pageId;
    const changesInput = approvalActionInput(
      fixture,
      successor,
      "changes_requested",
      "request-successor-changes",
      {
        notes: "  عدّل   موضع النص  ",
        affectedScopes: [{ kind: "page", pageId }],
      },
    );
    const changed = service.act(changesInput);
    expect(changed).toMatchObject({
      approvalState: "changes_requested",
      gateState: "canceled",
      currentContentApprovalId: null,
      projectStatus: "revising",
    });
    expect(
      fixture.layout.bookApprovalCycles.get(successor.cycle.id),
    ).toMatchObject({
      notes: "عدّل موضع النص",
      affectedScopes: [{ kind: "page", pageId }],
    });
    expect(
      fixture.layout.bookApprovalCycles.get(original.cycle.id),
    ).toMatchObject({
      state: "invalidated",
      invalidatedBy: { matrixRow: "IM-11" },
    });
    expect(service.act(changesInput)).toEqual({ ...changed, replayed: true });
    expect(() =>
      service.act({ ...changesInput, notes: "طلب مختلف" }),
    ).toThrowError("APPROVAL_IDEMPOTENCY_COLLISION");
    expect(fixture.layout.bookApprovalActions.list()).toHaveLength(4);
    fixture.store.close();
  });

  it("rejects a stale two-tab action without mutating the cycle, gate, or ledger", async () => {
    const fixture = await harness();
    const bundle = addPreviewBundle(fixture);
    const service = new BookApprovalService(fixture.store, fixture.scheduler);
    const stale = approvalActionInput(
      fixture,
      bundle,
      "preview_sent",
      "stale-tab",
    );
    const cycleBefore = fixture.layout.bookApprovalCycles.get(bundle.cycle.id);
    const gateBefore = fixture.scheduler.get(bundle.gateId);

    const project = fixture.authoring.projects.get(fixture.projectId)!;
    fixture.authoring.projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: "2026-07-15T03:00:00.000Z",
    });
    expect(() => service.act(stale)).toThrowError("APPROVAL_REVISION_CONFLICT");
    expect(fixture.layout.bookApprovalCycles.get(bundle.cycle.id)).toEqual(
      cycleBefore,
    );
    expect(fixture.scheduler.get(bundle.gateId)).toEqual(gateBefore);
    expect(fixture.layout.bookApprovalActions.list()).toHaveLength(0);
    fixture.store.close();
  });
});

async function harness() {
  const temp = await temporaryDirectory("hekayati-layout-approval-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(resolveDataPaths(temp.path).database);
  return createApprovalFixture(store);
}

function mutableIntegrity(assetId: string, checksum: string) {
  let status: "healthy" | "corrupt" = "healthy";
  return {
    port: {
      verifyIntegrity: async (requestedId: string) => ({
        status,
        expectedSha256: requestedId === assetId ? checksum : "0".repeat(64),
      }),
    },
    setStatus: (next: "healthy" | "corrupt") => {
      status = next;
    },
  };
}
