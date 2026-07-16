import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { PrinterProfileService } from "../../src/domain/print/profiles.js";
import { createDefaultPrinterProfileDraft } from "../../src/domain/print/schemas.js";
import {
  change,
  cleanupPrintInvalidationFixtures,
  enqueuePrintJob,
  fence,
  printInvalidationAt,
  seedDeliverable,
} from "../helpers/print-invalidation-fixtures.js";

afterEach(cleanupPrintInvalidationFixtures);

describe("print invalidation participant", () => {
  it("IM-14 stales both artifacts and preflight without revoking approval", async () => {
    const fixture = await seedDeliverable();
    const approvalId = fixture.project.currentContentApprovalId;

    new PrinterProfileService(fixture.store, fixture.assets, {
      now: () => printInvalidationAt,
      invalidation: fixture.invalidation,
    }).update({
      profileId: fixture.profile.profile.id,
      expectedRevision: fixture.profile.profile.revision,
      name: fixture.profile.profile.name,
      archived: false,
      draft: {
        ...createDefaultPrinterProfileDraft(),
        spine: { source: "explicit", widthMm: 9 },
      },
    });

    expect(fixture.print.runs.get(fixture.run.id)).toMatchObject({
      state: "stale",
      currentInteriorArtifactId: null,
      currentCoverArtifactId: null,
      currentPreflightReportId: null,
      staleReasons: ["IM_14"],
    });
    expect(fixture.authoring.projects.get(fixture.project.id)).toMatchObject({
      currentContentApprovalId: approvalId,
      status: "approved",
    });
  });

  it("routes a real page-scoped IM-11 event into the current print run", async () => {
    const fixture = await seedDeliverable();
    fixture.invalidation.recordAndConsume(
      change(fixture.pageId, "IM-11", "narrative_text"),
    );
    expect([
      fixture.print.runs.get(fixture.run.id)?.state,
      fixture.authoring.projects.get(fixture.project.id)
        ?.currentContentApprovalId,
    ]).toEqual(["stale", null]);
  });

  it("IM-15 preserves the exact interior and invalidates cover/preflight only", async () => {
    const fixture = await seedDeliverable();

    fixture.invalidation.recordAndConsume(
      change(fixture.project.id, "IM-15", "cover_template"),
    );

    expect(fixture.print.runs.get(fixture.run.id)).toMatchObject({
      state: "stale",
      currentInteriorArtifactId: fixture.interior.id,
      currentCoverArtifactId: null,
      currentPreflightReportId: null,
      staleReasons: ["IM_15"],
    });
    expect(fixture.print.artifacts.get(fixture.interior.id)).toEqual(
      fixture.interior,
    );
  });

  it.each(["IM-18", "IM-19"] as const)(
    "%s leaves the print projection byte-for-byte unchanged",
    async (row) => {
      const fixture = await seedDeliverable();

      const result = fixture.invalidation.recordAndConsume(
        change(fixture.project.id, row, "internal"),
      );

      expect(result.audit.affectedIds).not.toContain(fixture.run.id);
      expect(fixture.print.runs.get(fixture.run.id)).toEqual(fixture.run);
    },
  );

  it("cancels every owned nonterminal producer while preserving terminal jobs", async () => {
    const fixture = await seedDeliverable({ producerState: "in_flight" });
    const before = fixture.jobs.map((job) => fixture.scheduler.get(job.id)!);
    expect(before.map((job) => job.state)).toEqual([
      "running",
      "queued",
      "blocked",
    ]);

    fixture.invalidation.recordAndConsume(
      change(fixture.project.id, "IM-11", "book_content"),
    );

    expect(
      fixture.jobs.map((job) => fixture.scheduler.get(job.id)?.state),
    ).toEqual(["canceled", "canceled", "canceled"]);
    for (const job of fixture.jobs)
      expect(fixture.scheduler.events(job.id).at(-1)).toMatchObject({
        kind: "canceled",
        fromState: expect.any(String),
        toState: "canceled",
      });

    const completed = await seedDeliverable();
    const terminalBefore = completed.jobs.map((job) =>
      completed.scheduler.get(job.id)!,
    );
    completed.invalidation.recordAndConsume(
      change(completed.project.id, "IM-14", "printer_profile"),
    );
    expect(
      completed.jobs.map((job) => completed.scheduler.get(job.id)),
    ).toEqual(terminalBefore);
  });

  it("rolls back all cancellations when an attached job fails ownership", async () => {
    const fixture = await seedDeliverable({ producerState: "in_flight" });
    const beforeJobs = fixture.jobs.map((job) =>
      fixture.scheduler.get(job.id)!,
    );
    const foreign = enqueuePrintJob(
      fixture.scheduler,
      ulid(),
      fixture.project.id,
      "print_preflight",
      "foreign-run",
    );
    const current = fixture.print.runs.get(fixture.run.id)!;
    const attached = fixture.print.runs.update(current.revision, {
      ...current,
      revision: current.revision + 1,
      preflightJobId: foreign.id,
    });

    expect(() =>
      fixture.invalidation.recordAndConsume(
        change(fixture.project.id, "IM-11", "book_content"),
      ),
    ).toThrowError("PRINT_RUN_STALE");
    expect(fixture.jobs.map((job) => fixture.scheduler.get(job.id))).toEqual(
      beforeJobs,
    );
    expect(fixture.scheduler.get(foreign.id)).toEqual(foreign);
    expect(fixture.print.runs.get(fixture.run.id)).toEqual(attached);
  });

  it.each([
    ["IM-11", "book_content"],
    ["IM-15", "cover_template"],
  ] as const)(
    "%s cancels a waiting CMYK proof gate without mutating its evidence",
    async (row, entity) => {
      const fixture = await seedDeliverable({ proofGate: "waiting_review" });
      const gate = fixture.proofGate!;

      fixture.invalidation.recordAndConsume(
        change(fixture.project.id, row, entity),
      );

      expect(fixture.scheduler.get(gate.id)).toMatchObject({
        state: "canceled",
        stateReason: `print_invalidated_${row.toLowerCase()}`,
        request: gate.request,
        inputSnapshot: gate.inputSnapshot,
      });
      expect(fixture.print.runs.get(fixture.run.id)).toMatchObject({
        state: "stale",
        currentInteriorArtifactId: row === "IM-15" ? fixture.interior.id : null,
        currentCoverArtifactId: null,
        currentPreflightReportId: null,
        convertedProofGateJobId: null,
        convertedProofBundleHash: null,
      });
    },
  );

  it("preserves an already-succeeded proof gate byte-for-byte", async () => {
    const fixture = await seedDeliverable({ proofGate: "succeeded" });
    const gate = fixture.scheduler.get(fixture.proofGate!.id)!;

    fixture.invalidation.recordAndConsume(
      change(fixture.project.id, "IM-15", "cover_template"),
    );

    expect(fixture.scheduler.get(gate.id)).toEqual(gate);
    expect(fixture.print.artifacts.get(fixture.interior.id)).toEqual(
      fixture.interior,
    );
  });

  it("keeps IM-19 in-flight work commit-capable and the print run unchanged", async () => {
    const fixture = await seedDeliverable({ producerState: "in_flight" });
    const running = fixture.scheduler.get(fixture.jobs[0].id)!;
    const beforeRun = fixture.print.runs.get(fixture.run.id)!;

    fixture.invalidation.recordAndConsume(
      change(fixture.project.id, "IM-19", "watermark_setting"),
    );

    expect(fixture.print.runs.get(fixture.run.id)).toEqual(beforeRun);
    expect(fixture.scheduler.get(running.id)).toEqual(running);
    expect(
      fixture.scheduler.commitSuccess(running.id, fence(running), []).state,
    ).toBe("succeeded");
  });

  it("freezes replay before later current work can be attached", async () => {
    const fixture = await seedDeliverable();
    const first = fixture.invalidation.recordAndConsume(
      change(fixture.project.id, "IM-15", "cover_template"),
    );
    const later = enqueuePrintJob(
      fixture.scheduler,
      fixture.run.id,
      fixture.project.id,
      "print_preflight",
      "later-replay-work",
    );
    const stale = fixture.print.runs.get(fixture.run.id)!;
    const attached = fixture.print.runs.update(stale.revision, {
      ...stale,
      revision: stale.revision + 1,
      preflightJobId: later.id,
    });

    expect(fixture.invalidation.consume(first.event.id)).toEqual(first.audit);
    expect(fixture.print.runs.get(fixture.run.id)).toEqual(attached);
    expect(fixture.scheduler.get(later.id)).toEqual(later);
  });
});
