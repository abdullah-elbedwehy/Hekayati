import { afterEach, describe, expect, it } from "vitest";

import { LayoutRepositories } from "../../src/domain/layout/repositories.js";
import { waitForValue } from "../helpers/creative-fixtures.js";
import { createLayoutWorkflowFixture } from "../helpers/layout-workflow-fixture.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("durable automatic layout workflow", () => {
  it("materializes exact layouts, persists pdf_pending, then commits one validated preview bundle", async () => {
    const temp = await temporaryDirectory("hekayati-layout-workflow-");
    cleanups.push(temp.cleanup);
    const fixture = await createLayoutWorkflowFixture(temp.path);

    const started = fixture.workflow.start(fixture.seed.projectId);
    expect(started).toMatchObject({
      state: "layout_pending",
      projectId: fixture.seed.projectId,
      blockingReasons: [],
    });
    expect(started.layoutJobIds).toHaveLength(16);
    expect(
      fixture.runtime.scheduler
        .list()
        .every((job) => job.target === null && job.request.kind === "local"),
    ).toBe(true);

    fixture.runtime.start();
    const ready = await waitForValue(
      () => {
        const current = fixture.workflow.projectWorkflow(
          fixture.seed.projectId,
        );
        return current?.state === "ready" ? current : null;
      },
      90_000,
      () => JSON.stringify(fixture.runtime.queueProjection().counts),
    );
    const repositories = new LayoutRepositories(fixture.store);
    expect(repositories.pageLayoutHeads.list()).toHaveLength(16);
    expect(repositories.layoutVersions.list()).toHaveLength(16);
    expect(repositories.coverCompositionVersions.list()).toHaveLength(1);
    expect(repositories.previewOutputs.list()).toHaveLength(1);
    expect(repositories.bookApprovalCycles.list()).toHaveLength(1);
    expect(ready.previewJobId).not.toBeNull();
    expect(fixture.runtime.scheduler.get(ready.previewJobId!)).toMatchObject({
      state: "succeeded",
    });
    const output = repositories.previewOutputs.list()[0];
    expect(output).toMatchObject({
      projectId: fixture.seed.projectId,
      status: "ready",
      validationReport: { passed: true, pageCount: 18 },
    });
    expect(fixture.assets.get(output.assetId)).toMatchObject({
      role: "pdf_preview",
      mime: "application/pdf",
    });
    expect(
      fixture.runtime.scheduler.get(output.approvalGateJobId),
    ).toMatchObject({
      state: "waiting_review",
      request: {
        kind: "human_gate",
        gateKind: "customer_approval",
        targetVersionId: output.id,
      },
    });
    expect(fixture.workflow.start(fixture.seed.projectId).layoutJobIds).toEqual(
      started.layoutJobIds,
    );

    await fixture.runtime.stop();
    fixture.store.close();
  }, 120_000);

  it("assembles the complete 24-page interior and two proof covers through the durable graph", async () => {
    const temp = await temporaryDirectory("hekayati-layout-workflow-24-");
    cleanups.push(temp.cleanup);
    const fixture = await createLayoutWorkflowFixture(temp.path, 24);
    const started = fixture.workflow.start(fixture.seed.projectId);
    expect(started.layoutJobIds).toHaveLength(24);
    fixture.runtime.start();

    const ready = await waitForValue(
      () => {
        const current = fixture.workflow.projectWorkflow(
          fixture.seed.projectId,
        );
        return current?.state === "ready" ? current : null;
      },
      90_000,
      () => JSON.stringify(fixture.runtime.queueProjection().counts),
    );
    const repositories = new LayoutRepositories(fixture.store);
    const output = repositories.previewOutputs.list()[0];
    expect(repositories.pageLayoutHeads.list()).toHaveLength(24);
    expect(repositories.layoutVersions.list()).toHaveLength(24);
    expect(repositories.previewOutputs.list()).toHaveLength(1);
    expect(output).toMatchObject({
      status: "ready",
      validationReport: {
        passed: true,
        pageCount: 26,
        expectedPageCount: 26,
        interiorPageCount: 24,
        egressRequestCount: 0,
      },
    });
    expect(output.validationReport.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(
      output.validationReport.pageResults.every(
        (page) => page.watermarkPresent && page.footerPresent,
      ),
    ).toBe(true);
    expect(fixture.runtime.scheduler.get(ready.previewJobId!)).toMatchObject({
      state: "succeeded",
    });

    await fixture.runtime.stop();
    fixture.store.close();
  }, 120_000);
});
