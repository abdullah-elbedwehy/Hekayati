import { describe, expect, it, vi } from "vitest";

import { CreativePipelineService } from "../../src/domain/creative/pipeline.js";
import type { JobRecord } from "../../src/jobs/schemas.js";

const at = "2026-07-14T00:00:00.000Z";
const id = (index: number) => `01J${String(index).padStart(23, "0")}`;

describe("creative pipeline service guards", () => {
  it("requires one scheduler binding and rejects a silent rebind", () => {
    const pipeline = unboundPipeline();
    expect(() =>
      pipeline.startRun({ customerId: id(1), familyId: id(2) }, id(3), {
        expectedProjectVersionId: id(4),
        expectedStoryVersionId: id(5),
      }),
    ).toThrowError(expect.objectContaining({ code: "CREATIVE_JOB_NOT_BOUND" }));

    const first = { enqueue: vi.fn() };
    pipeline.bindScheduler(first as never);
    expect(() => pipeline.bindScheduler(first as never)).not.toThrow();
    expect(() =>
      pipeline.bindScheduler({ enqueue: vi.fn() } as never),
    ).toThrowError(expect.objectContaining({ code: "CREATIVE_JOB_NOT_BOUND" }));
  });

  it("rejects every stale run, node, project, and story lineage fence", () => {
    const fixture = guardedPipeline();
    const job = creativeJob();

    expect(() =>
      fixture.pipeline.assertJobCurrent({
        ...job,
        inputSnapshot: {},
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );

    fixture.run.status = "failed";
    expect(() => fixture.pipeline.assertJobCurrent(job)).toThrowError(
      expect.objectContaining({ code: "CREATIVE_RUN_STATE_INVALID" }),
    );
    fixture.run.status = "stale";
    expect(() => fixture.pipeline.assertJobCurrent(job)).toThrowError(
      expect.objectContaining({ code: "CREATIVE_RUN_STATE_INVALID" }),
    );

    fixture.run.status = "generating";
    fixture.run.nodes = [];
    expect(() => fixture.pipeline.assertJobCurrent(job)).toThrowError(
      expect.objectContaining({ code: "CREATIVE_JOB_NOT_BOUND" }),
    );

    fixture.run.nodes = [node("story_plan", job.id, null)];
    fixture.project.currentVersionId = id(99);
    expect(() => fixture.pipeline.assertJobCurrent(job)).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    fixture.project.currentVersionId = fixture.run.projectVersionId;
    fixture.projects.get.mockImplementationOnce(() => null);
    expect(() => fixture.pipeline.assertJobCurrent(job)).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );

    expect(() =>
      fixture.pipeline.assertJobCurrent({
        ...job,
        inputSnapshot: { run: fixture.run.id, storyVersion: id(98) },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    expect(() =>
      fixture.pipeline.assertJobCurrent({
        ...job,
        inputSnapshot: {
          run: fixture.run.id,
          storyVersion: fixture.run.inputStoryVersionId,
        },
      }),
    ).not.toThrow();
  });

  it("rejects missing runs, invalid regeneration state, and unbound illustration nodes", () => {
    const fixture = guardedPipeline();
    expect(() => fixture.pipeline.getRun(id(97))).toThrowError(
      expect.objectContaining({ code: "CREATIVE_ENTITY_NOT_FOUND" }),
    );
    expect(() =>
      fixture.pipeline.regenerateIllustration({
        runId: fixture.run.id,
        pageId: id(50),
        expectedPageRevision: 0,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_RUN_STATE_INVALID" }),
    );

    fixture.run.status = "internal_review";
    fixture.pages.getPage.mockReturnValueOnce({
      id: id(50),
      projectId: id(96),
      revision: 0,
      kind: "story",
      locked: false,
      currentPromptVersionId: id(51),
      storyPageIndex: 1,
    });
    expect(() =>
      fixture.pipeline.regenerateIllustration({
        runId: fixture.run.id,
        pageId: id(50),
        expectedPageRevision: 0,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_REVISION_CONFLICT" }),
    );

    const job = creativeJob();
    fixture.run.status = "generating";
    fixture.run.nodes = [node("story_plan", job.id, null)];
    expect(() =>
      fixture.pipeline.commitIllustration(job, id(52), provenance),
    ).toThrowError(expect.objectContaining({ code: "CREATIVE_JOB_NOT_BOUND" }));

    fixture.run.nodes = [node("page_illustration", job.id, 1)];
    fixture.pages.listProjectPages.mockReturnValueOnce([]);
    expect(() =>
      fixture.pipeline.commitIllustration(job, id(52), provenance),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_ENTITY_NOT_FOUND" }),
    );
  });

  it("keeps internal review open while an exact block finding is unacknowledged", () => {
    const fixture = guardedPipeline();
    const gateId = id(70);
    fixture.run.status = "internal_review";
    fixture.run.revision = 4;
    fixture.run.internalReviewGateJobId = gateId;
    fixture.run.nodes = [node("internal_review", gateId, null)];
    fixture.pages.listProjectPages.mockReturnValue([
      {
        kind: "story",
        reviewStatus: "approved",
        staleState: "current",
        currentIllustrationVersionId: id(71),
      },
    ]);
    fixture.stages.reviewFindings.mockReturnValue({
      schemaVersion: 1,
      findings: [
        {
          scope: "page",
          refId: id(72),
          pageNumber: 1,
          category: "safety",
          severity: "block",
          excerpt: "مقتطف اصطناعي",
          note: "يلزم قرار المشغّل",
        },
      ],
    });
    fixture.scheduler.completeHumanGate.mockImplementation(
      (_gateId, _input, complete) => complete({ id: gateId }),
    );

    expect(() =>
      fixture.pipeline.completeInternalReview({
        runId: fixture.run.id,
        expectedRunRevision: fixture.run.revision,
        gateJobId: gateId,
        expectedGateRevision: 0,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_FINDINGS_BLOCK" }),
    );
    expect(fixture.projects.update).not.toHaveBeenCalled();
  });
});

function unboundPipeline() {
  return new CreativePipelineService(
    { transaction: (work: () => unknown) => work() } as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function guardedPipeline() {
  const pipeline = unboundPipeline();
  const run = {
    id: id(10),
    projectId: id(11),
    projectVersionId: id(12),
    inputStoryVersionId: id(13),
    outputStoryVersionId: null as string | null,
    status: "generating",
    revision: 0,
    internalReviewGateJobId: null as string | null,
    nodes: [node("story_plan", id(20), null)],
  };
  const project = {
    id: run.projectId,
    customerId: id(14),
    familyId: id(15),
    currentVersionId: run.projectVersionId,
  };
  const runs = {
    get: vi.fn((runId: string) => (runId === run.id ? run : null)),
    queryByField: vi.fn(() => [run]),
    update: vi.fn((value) => value),
  };
  const projects = {
    get: vi.fn((): typeof project | null => project),
    update: vi.fn((value) => value),
  };
  const pages = {
    getPage: vi.fn(),
    listProjectPages: vi.fn((): unknown[] => []),
    appendIllustration: vi.fn(),
  };
  const stages = {
    reviewFindings: vi.fn(
      (): { schemaVersion: number; findings: unknown[] } => ({
        schemaVersion: 1,
        findings: [],
      }),
    ),
  };
  const scheduler = {
    completeHumanGate: vi.fn(),
  };
  Object.assign(pipeline, {
    repositories: {
      runs,
      acknowledgements: { queryByField: vi.fn(() => []) },
    },
    authoringRepositories: { projects },
    pages,
    stages,
    scheduler,
  });
  return { pipeline, run, project, runs, projects, pages, stages, scheduler };
}

function creativeJob() {
  return {
    id: id(20),
    inputSnapshot: { run: id(10) },
  } as unknown as JobRecord;
}

function node(kind: string, jobId: string, pageNumber: number | null) {
  return {
    key: kind,
    kind,
    pageNumber,
    dependsOnKeys: [],
    intentId: `${kind}-intent`,
    jobId,
    state: "materialized",
  };
}

const provenance = {
  provider: "mock" as const,
  modelId: "mock-image-v1",
  at,
  inputVersionRefs: {},
  promptVersion: "mock-v1",
  referenceAssetIds: [],
  attempt: 1,
  settingsSnapshotHash: "c".repeat(64),
};
