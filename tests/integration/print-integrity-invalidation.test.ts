import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import {
  change,
  cleanupPrintInvalidationFixtures,
  enqueuePrintJob,
  enqueueProducerJobs,
  fence,
  printInvalidationAt,
  seedDeliverable,
  startNext,
} from "../helpers/print-invalidation-fixtures.js";

afterEach(cleanupPrintInvalidationFixtures);

describe("print IM-20 integrity invalidation", () => {
  it("blocks corrupt bytes and exact repair restores the same run without work", async () => {
    const fixture = await seedDeliverable();
    await writeFile(
      fixture.assets.pathForRecord(fixture.source),
      Buffer.from("corrupt"),
    );
    const input = change(fixture.source.id, "IM-20", "asset_integrity");

    const first = fixture.invalidation.recordAndConsume(input);
    const blocked = fixture.print.runs.get(fixture.run.id)!;
    expect(blocked).toMatchObject({
      state: "blocked",
      blockingReasons: ["ASSET_INTEGRITY_BLOCKED"],
      currentInteriorArtifactId: fixture.interior.id,
      currentCoverArtifactId: fixture.cover.id,
      currentPreflightReportId: fixture.report.id,
    });
    expect(fixture.invalidation.consume(first.event.id)).toEqual(first.audit);
    expect(fixture.print.runs.get(fixture.run.id)?.revision).toBe(
      blocked.revision,
    );

    await writeFile(
      fixture.assets.pathForRecord(fixture.source),
      fixture.sourceBytes,
    );
    const repaired = fixture.printInvalidation.reconcileIntegrity(
      fixture.source.id,
    );

    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({
      id: fixture.run.id,
      state: "deliverable",
      blockingReasons: [],
      currentInteriorArtifactId: fixture.interior.id,
      currentCoverArtifactId: fixture.cover.id,
      currentPreflightReportId: fixture.report.id,
    });
    expect(fixture.authoring.projects.get(fixture.project.id)?.status).toBe(
      "print_ready",
    );
  });

  it("leaves unrelated runs in the same project byte-for-byte unchanged", async () => {
    const fixture = await seedDeliverable();
    const unrelatedSource = await fixture.assets.put({
      bytes: Buffer.from("synthetic-unrelated-source"),
      extension: "png",
      mime: "image/png",
      role: "illustration",
      origin: "derived",
      width: 2_480,
      height: 3_508,
      dpi: 300,
    });
    const unrelatedRunId = ulid();
    const unrelatedJobs = enqueueProducerJobs(
      fixture.scheduler,
      unrelatedRunId,
      fixture.project.id,
    );
    const unrelatedRun = fixture.print.runs.insert({
      ...fixture.run,
      id: unrelatedRunId,
      revision: 0,
      requestHash: "3".repeat(64),
      idempotencyKey: `unrelated-${unrelatedRunId}`,
      sourceAssets: [
        {
          role: "illustration",
          assetId: unrelatedSource.id,
          checksum: unrelatedSource.sha256,
        },
      ],
      state: "queued",
      interiorJobId: unrelatedJobs[0].id,
      coverJobId: unrelatedJobs[1].id,
      preflightJobId: unrelatedJobs[2].id,
      convertedProofGateJobId: null,
      currentInteriorArtifactId: null,
      currentCoverArtifactId: null,
      currentPreflightReportId: null,
      convertedProofBundleHash: null,
      blockingReasons: [],
      staleReasons: [],
      invalidatedByEventIds: [],
    });
    const unrelatedJobsBefore = unrelatedJobs.map((job) =>
      fixture.scheduler.get(job.id),
    );
    await writeFile(
      fixture.assets.pathForRecord(fixture.source),
      Buffer.from("corrupt"),
    );

    fixture.invalidation.recordAndConsume(
      change(fixture.source.id, "IM-20", "asset_integrity"),
    );

    expect(fixture.print.runs.get(fixture.run.id)?.state).toBe("blocked");
    expect(fixture.print.runs.get(unrelatedRun.id)).toEqual(unrelatedRun);
    expect(unrelatedJobs.map((job) => fixture.scheduler.get(job.id))).toEqual(
      unrelatedJobsBefore,
    );

    await writeFile(
      fixture.assets.pathForRecord(fixture.source),
      fixture.sourceBytes,
    );
    fixture.printInvalidation.reconcileIntegrity(fixture.source.id);
    expect(fixture.print.runs.get(unrelatedRun.id)).toEqual(unrelatedRun);
    expect(unrelatedJobs.map((job) => fixture.scheduler.get(job.id))).toEqual(
      unrelatedJobsBefore,
    );
  });

  it("pauses in-flight work and requires explicit resume after exact repair", async () => {
    const fixture = await seedDeliverable();
    const pending = enqueuePrintJob(
      fixture.scheduler,
      fixture.run.id,
      fixture.project.id,
      "print_preflight",
      "integrity-recovery",
    );
    const running = startNext(fixture.scheduler);
    expect(running.id).toBe(pending.id);
    const current = fixture.print.runs.get(fixture.run.id)!;
    fixture.print.runs.update(current.revision, {
      ...current,
      revision: current.revision + 1,
      state: "preflight_pending",
      preflightJobId: pending.id,
      currentPreflightReportId: null,
    });
    await writeFile(
      fixture.assets.pathForRecord(fixture.source),
      Buffer.from("corrupt"),
    );

    fixture.invalidation.recordAndConsume(
      change(fixture.source.id, "IM-20", "asset_integrity"),
    );

    expect(fixture.scheduler.get(pending.id)).toMatchObject({
      state: "paused",
      stateReason: "asset_integrity",
      resumeState: "queued",
      lease: null,
    });
    expect(() =>
      fixture.scheduler.commitSuccess(running.id, fence(running), []),
    ).toThrowError("JOB_FENCE_MISMATCH");

    await writeFile(
      fixture.assets.pathForRecord(fixture.source),
      fixture.sourceBytes,
    );
    fixture.printInvalidation.reconcileIntegrity(fixture.source.id);

    const repairedJob = fixture.scheduler.get(pending.id)!;
    expect(fixture.print.runs.get(fixture.run.id)).toMatchObject({
      state: "preflight_pending",
      currentPreflightReportId: null,
      blockingReasons: [],
    });
    expect(repairedJob).toMatchObject({
      state: "paused",
      stateReason: "operator",
      resumeState: "queued",
    });
    expect(
      fixture.scheduler.claimNext({
        workerId: "no-automatic-repair-worker",
        bootId: "no-automatic-repair-boot",
        nowMonoMs: 20,
        nowWallMs: Date.parse(printInvalidationAt),
        leaseTtlMs: 1_000,
        concurrencyPerProvider: 2,
      }),
    ).toBeNull();
    expect(
      fixture.scheduler.resume(repairedJob.id, {
        expectedRevision: repairedJob.revision,
        expectedState: "paused",
      }),
    ).toMatchObject({ state: "queued", stateReason: null });
  });

  it("exact repair preserves an existing failed-preflight block", async () => {
    const fixture = await seedDeliverable();
    const failedReport = fixture.print.preflightReports.insert({
      ...fixture.report,
      id: ulid(),
      findings: [
        {
          code: "FONT_EMBEDDING_MISSING",
          artifact: "interior",
          page: 1,
          severity: "blocking",
          expected: "embedded",
          actual: "missing",
        },
      ],
      passed: false,
    });
    const current = fixture.print.runs.get(fixture.run.id)!;
    fixture.print.runs.update(current.revision, {
      ...current,
      revision: current.revision + 1,
      state: "blocked",
      currentPreflightReportId: failedReport.id,
      blockingReasons: ["FONT_EMBEDDING_MISSING"],
    });
    await writeFile(
      fixture.assets.pathForRecord(fixture.source),
      Buffer.from("corrupt"),
    );
    fixture.invalidation.recordAndConsume(
      change(fixture.source.id, "IM-20", "asset_integrity"),
    );

    await writeFile(
      fixture.assets.pathForRecord(fixture.source),
      fixture.sourceBytes,
    );
    fixture.printInvalidation.reconcileIntegrity(fixture.source.id);

    expect(fixture.print.runs.get(fixture.run.id)).toMatchObject({
      state: "blocked",
      currentPreflightReportId: failedReport.id,
      blockingReasons: ["FONT_EMBEDDING_MISSING"],
    });
  });

  it("refuses to clear after different bytes replace the source", async () => {
    const fixture = await seedDeliverable();
    await writeFile(
      fixture.assets.pathForRecord(fixture.source),
      Buffer.from("corrupt"),
    );
    fixture.invalidation.recordAndConsume(
      change(fixture.source.id, "IM-20", "asset_integrity"),
    );
    const blocked = fixture.print.runs.get(fixture.run.id)!;
    await writeFile(
      fixture.assets.pathForRecord(fixture.source),
      Buffer.from("different-version-needs-reapproval"),
    );

    expect(
      fixture.printInvalidation.reconcileIntegrity(fixture.source.id),
    ).toEqual([]);
    expect(fixture.print.runs.get(fixture.run.id)).toEqual(blocked);
  });
});
