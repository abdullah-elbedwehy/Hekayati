import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { resolveDataPaths } from "../../src/config/paths.js";
import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import {
  CreativeInvalidationService,
  type AppendChangeEventInput,
} from "../../src/domain/creative/invalidation.js";
import { BookApprovalService } from "../../src/domain/layout/approvals.js";
import { LayoutRepositories } from "../../src/domain/layout/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { waitForValue } from "../helpers/creative-fixtures.js";
import {
  addPreviewBundle,
  createApprovalFixture,
} from "../helpers/layout-approval-fixtures.js";
import { createLayoutWorkflowFixture } from "../helpers/layout-workflow-fixture.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("layout invalidation participant", () => {
  it.each(invalidatingRows)(
    "applies %s to real preview and approval records once without regeneration",
    async (matrixRow) => {
      const temp = await temporaryDirectory(`hekayati-layout-${matrixRow}-`);
      cleanups.push(temp.cleanup);
      const store = new DocumentStore(resolveDataPaths(temp.path).database);
      const fixture = createApprovalFixture(store);
      const bundle = addPreviewBundle(fixture);
      const invalidation = new CreativeInvalidationService(store);
      invalidation.bindGateController(fixture.scheduler);
      const projectBefore = fixture.authoring.projects.get(fixture.projectId)!;

      const { event: change, audit } = invalidation.recordAndConsume(
        matrixEvent(matrixRow, fixture.projectId),
      );
      expect(fixture.layout.previewOutputs.get(bundle.output.id)).toMatchObject(
        {
          status: "stale",
          staleReasons: [matrixRow],
          invalidatedByEventIds: [change.id],
        },
      );
      expect(
        fixture.layout.bookApprovalCycles.get(bundle.cycle.id),
      ).toMatchObject({
        state: "invalidated",
        invalidatedBy: { eventId: change.id, matrixRow },
      });
      expect(fixture.scheduler.get(bundle.gateId)?.state).toBe("canceled");
      expect(audit.affectedIds.sort()).toEqual(
        [bundle.output.id, bundle.cycle.id].sort(),
      );
      expect(
        fixture.authoring.projects.get(fixture.projectId)?.bookVersion,
      ).toBe(projectBefore.bookVersion + 1);
      expect(fixture.layout.previewOutputs.list()).toHaveLength(1);
      expect(fixture.layout.bookApprovalCycles.list()).toHaveLength(1);

      const after = {
        output: fixture.layout.previewOutputs.get(bundle.output.id),
        cycle: fixture.layout.bookApprovalCycles.get(bundle.cycle.id),
        gate: fixture.scheduler.get(bundle.gateId),
        project: fixture.authoring.projects.get(fixture.projectId),
      };
      expect(invalidation.consume(change.id)).toEqual(audit);
      expect({
        output: fixture.layout.previewOutputs.get(bundle.output.id),
        cycle: fixture.layout.bookApprovalCycles.get(bundle.cycle.id),
        gate: fixture.scheduler.get(bundle.gateId),
        project: fixture.authoring.projects.get(fixture.projectId),
      }).toEqual(after);
      store.close();
    },
  );

  it.each(["IM-19", "IM-20"] as const)(
    "treats %s as preview staleness plus approval recheck without a book bump",
    async (matrixRow) => {
      const temp = await temporaryDirectory(`hekayati-layout-${matrixRow}-`);
      cleanups.push(temp.cleanup);
      const store = new DocumentStore(resolveDataPaths(temp.path).database);
      const fixture = createApprovalFixture(store);
      const bundle = addPreviewBundle(fixture);
      const invalidation = new CreativeInvalidationService(store);
      invalidation.bindGateController(fixture.scheduler);
      const before = fixture.authoring.projects.get(fixture.projectId)!;
      const input =
        matrixRow === "IM-19"
          ? matrixEvent(matrixRow, fixture.projectId)
          : assetIntegrityEvent(fixture.assetId);

      const { audit } = invalidation.recordAndConsume(input);
      expect(fixture.layout.previewOutputs.get(bundle.output.id)).toMatchObject(
        {
          status: "stale",
          staleReasons: [matrixRow],
        },
      );
      expect(
        fixture.layout.bookApprovalCycles.get(bundle.cycle.id),
      ).toMatchObject({
        state: "ready_to_send",
        attentionReasons: [matrixRow],
      });
      expect(fixture.scheduler.get(bundle.gateId)?.state).toBe("canceled");
      expect(
        fixture.authoring.projects.get(fixture.projectId)?.bookVersion,
      ).toBe(before.bookVersion);
      expect(audit.affectedIds.sort()).toEqual(
        [bundle.output.id, bundle.cycle.id].sort(),
      );
      store.close();
    },
  );

  it.each(["IM-14", "IM-18"] as const)(
    "keeps real composition approval unchanged for %s",
    async (matrixRow) => {
      const temp = await temporaryDirectory(`hekayati-layout-${matrixRow}-`);
      cleanups.push(temp.cleanup);
      const store = new DocumentStore(resolveDataPaths(temp.path).database);
      const fixture = createApprovalFixture(store);
      const bundle = addPreviewBundle(fixture);
      const invalidation = new CreativeInvalidationService(store);
      invalidation.bindGateController(fixture.scheduler);
      const before = {
        output: fixture.layout.previewOutputs.get(bundle.output.id),
        cycle: fixture.layout.bookApprovalCycles.get(bundle.cycle.id),
        gate: fixture.scheduler.get(bundle.gateId),
        project: fixture.authoring.projects.get(fixture.projectId),
      };

      const { audit } = invalidation.recordAndConsume(
        matrixEvent(matrixRow, fixture.projectId),
      );
      expect(audit.affectedIds).toEqual([]);
      expect({
        output: fixture.layout.previewOutputs.get(bundle.output.id),
        cycle: fixture.layout.bookApprovalCycles.get(bundle.cycle.id),
        gate: fixture.scheduler.get(bundle.gateId),
        project: fixture.authoring.projects.get(fixture.projectId),
      }).toEqual(before);
      store.close();
    },
  );

  it("stales an unapproved preview and cancels its exact waiting gate in the receipt transaction", async () => {
    const fixture = await readyFixture();
    const layout = new LayoutRepositories(fixture.store);
    const authoring = new AuthoringRepositories(fixture.store);
    const before = currentBundle(layout, authoring, fixture.seed.projectId);
    const invalidation = new CreativeInvalidationService(fixture.store);
    invalidation.bindGateController(fixture.runtime.scheduler);
    const pageId = before.output.orderedInteriorPages[0].pageId;

    const { audit } = invalidation.recordAndConsume(
      event("layout", pageId, "layout_recalculation", "IM-11"),
    );
    const output = layout.previewOutputs.get(before.output.id)!;
    const cycle = layout.bookApprovalCycles.get(before.cycle.id)!;
    const gate = fixture.runtime.scheduler.get(before.gate.id)!;
    const project = authoring.projects.get(fixture.seed.projectId)!;
    expect(output).toMatchObject({
      status: "stale",
      staleReasons: ["IM-11"],
      invalidatedByEventIds: [audit.eventId],
    });
    expect(cycle).toMatchObject({
      state: "invalidated",
      invalidatedBy: { eventId: audit.eventId, matrixRow: "IM-11" },
    });
    expect(gate.state).toBe("canceled");
    expect(project.bookVersion).toBe(before.project.bookVersion + 1);
    expect(audit.affectedIds.sort()).toEqual([output.id, cycle.id].sort());
    expect(invalidation.consume(audit.eventId)).toEqual(audit);
  }, 120_000);

  it("keeps approved authorization for IM-19 but invalidates it for a visible-text row without mutating the succeeded gate", async () => {
    const fixture = await readyFixture();
    const layout = new LayoutRepositories(fixture.store);
    const authoring = new AuthoringRepositories(fixture.store);
    approveCurrent(fixture, layout, authoring);
    const before = currentBundle(layout, authoring, fixture.seed.projectId);
    const invalidation = new CreativeInvalidationService(fixture.store);
    invalidation.bindGateController(fixture.runtime.scheduler);

    invalidation.recordAndConsume(
      event(
        "watermark_setting",
        fixture.seed.projectId,
        "watermark_text",
        "IM-19",
      ),
    );
    const watermarkCycle = layout.bookApprovalCycles.get(before.cycle.id)!;
    const watermarkProject = authoring.projects.get(fixture.seed.projectId)!;
    expect(layout.previewOutputs.get(before.output.id)).toMatchObject({
      status: "stale",
      staleReasons: ["IM-19"],
    });
    expect(watermarkCycle).toMatchObject({
      state: "approved",
      attentionReasons: ["IM-19"],
    });
    expect(watermarkProject.currentContentApprovalId).toBe(before.cycle.id);
    expect(watermarkProject.bookVersion).toBe(before.project.bookVersion);
    expect(fixture.runtime.scheduler.get(before.gate.id)?.state).toBe(
      "succeeded",
    );

    const pageId = before.output.orderedInteriorPages[0].pageId;
    invalidation.recordAndConsume(
      event("narrative_text", pageId, "narrative_text", "IM-07"),
    );
    const invalidated = layout.bookApprovalCycles.get(before.cycle.id)!;
    const finalProject = authoring.projects.get(fixture.seed.projectId)!;
    expect(invalidated.state).toBe("invalidated");
    expect(finalProject.currentContentApprovalId).toBeNull();
    expect(finalProject.status).toBe("revising");
    expect(finalProject.bookVersion).toBe(before.project.bookVersion + 1);
    expect(fixture.runtime.scheduler.get(before.gate.id)?.state).toBe(
      "succeeded",
    );
  }, 120_000);
});

async function readyFixture() {
  const temp = await temporaryDirectory("hekayati-layout-invalidation-");
  cleanups.push(temp.cleanup);
  const fixture = await createLayoutWorkflowFixture(temp.path);
  cleanups.push(async () => {
    await fixture.runtime.stop();
    fixture.store.close();
  });
  fixture.workflow.start(fixture.seed.projectId);
  fixture.runtime.start();
  await waitForValue(() => {
    const workflow = fixture.workflow.projectWorkflow(fixture.seed.projectId);
    return workflow?.state === "ready" ? workflow : null;
  }, 90_000);
  return fixture;
}

function currentBundle(
  layout: LayoutRepositories,
  authoring: AuthoringRepositories,
  projectId: string,
) {
  const project = authoring.projects.get(projectId)!;
  const output = layout.previewOutputs.get(project.currentPreviewOutputId!)!;
  const cycle = layout.bookApprovalCycles.get(project.currentPreviewCycleId!)!;
  return { project, output, cycle, gate: { id: cycle.approvalGateJobId } };
}

function approveCurrent(
  fixture: Awaited<ReturnType<typeof readyFixture>>,
  layout: LayoutRepositories,
  authoring: AuthoringRepositories,
): void {
  const service = new BookApprovalService(
    fixture.store,
    fixture.runtime.scheduler,
  );
  let bundle = currentBundle(layout, authoring, fixture.seed.projectId);
  const sent = service.act(
    approvalInput(fixture, bundle, "preview_sent", "invalidation-send"),
  );
  expect(sent.approvalState).toBe("preview_sent");
  bundle = currentBundle(layout, authoring, fixture.seed.projectId);
  const approved = service.act(
    approvalInput(fixture, bundle, "approved", "invalidation-approve"),
  );
  expect(approved.approvalState).toBe("approved");
}

function approvalInput(
  fixture: Awaited<ReturnType<typeof readyFixture>>,
  bundle: ReturnType<typeof currentBundle>,
  action: "preview_sent" | "approved",
  idempotencyKey: string,
) {
  const gate = fixture.runtime.scheduler.get(bundle.gate.id)!;
  return {
    owner: fixture.seed.scope,
    projectId: fixture.seed.projectId,
    previewOutputId: bundle.output.id,
    cycleId: bundle.cycle.id,
    action,
    idempotencyKey,
    customerContentHash: bundle.output.customerContentHash,
    approvalBundleHash: bundle.output.approvalBundleHash,
    expectedProjectRevision: bundle.project.revision,
    expectedPreviewOutputRevision: bundle.output.revision,
    expectedApprovalRevision: bundle.cycle.revision,
    expectedGateRevision: gate.revision,
    expectedContentApprovalId: bundle.project.currentContentApprovalId,
    expectedContentApprovalRevision: null,
  } as const;
}

function event(
  entity: "layout" | "narrative_text" | "watermark_setting",
  entityId: string,
  changeType: "layout_recalculation" | "narrative_text" | "watermark_text",
  matrixRow: "IM-07" | "IM-11" | "IM-19",
): AppendChangeEventInput {
  const id = ulid();
  return {
    id,
    entity,
    entityId,
    fromVersionId: null,
    toVersionId: ulid(),
    changeType,
    matrixRow,
    changedFields: [changeType],
    correlationId: id,
  };
}

const invalidatingRows = [
  "IM-01",
  "IM-03",
  "IM-04",
  "IM-05",
  "IM-06",
  "IM-07",
  "IM-08",
  "IM-09",
  "IM-10",
  "IM-11",
  "IM-12",
  "IM-13",
] as const;

type MatrixEventRow =
  (typeof invalidatingRows)[number] | "IM-14" | "IM-18" | "IM-19";

const matrixEventKinds: Record<
  MatrixEventRow,
  Pick<AppendChangeEventInput, "entity" | "changeType">
> = {
  "IM-01": { entity: "character", changeType: "permanent_appearance" },
  "IM-03": { entity: "look", changeType: "shared_look" },
  "IM-04": { entity: "book_content", changeType: "project_look_override" },
  "IM-05": { entity: "book_content", changeType: "rename" },
  "IM-06": { entity: "scene", changeType: "scene_content" },
  "IM-07": { entity: "narrative_text", changeType: "narrative_text" },
  "IM-08": { entity: "story", changeType: "story_regeneration" },
  "IM-09": { entity: "page_count", changeType: "page_count" },
  "IM-10": { entity: "illustration", changeType: "illustration_regeneration" },
  "IM-11": { entity: "layout", changeType: "layout_recalculation" },
  "IM-12": { entity: "book_content", changeType: "book_content" },
  "IM-13": { entity: "project_style", changeType: "project_style" },
  "IM-14": { entity: "printer_profile", changeType: "printer_profile" },
  "IM-18": { entity: "internal", changeType: "internal_only" },
  "IM-19": { entity: "watermark_setting", changeType: "watermark_text" },
};

function matrixEvent(
  matrixRow: MatrixEventRow,
  projectId: string,
): AppendChangeEventInput {
  const id = ulid();
  return {
    id,
    ...matrixEventKinds[matrixRow],
    entityId: projectId,
    fromVersionId: null,
    toVersionId: ulid(),
    matrixRow,
    changedFields: [matrixEventKinds[matrixRow].changeType],
    correlationId: id,
  };
}

function assetIntegrityEvent(assetId: string): AppendChangeEventInput {
  const id = ulid();
  return {
    id,
    entity: "asset_integrity",
    entityId: assetId,
    fromVersionId: null,
    toVersionId: null,
    changeType: "asset_integrity",
    matrixRow: "IM-20",
    changedFields: ["checksum"],
    correlationId: id,
  };
}
