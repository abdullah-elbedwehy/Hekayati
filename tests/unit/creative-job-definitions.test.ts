import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { CreativeError } from "../../src/domain/creative/errors.js";
import { createCreativeJobDefinitions } from "../../src/jobs/creative-definitions.js";
import { JobError } from "../../src/jobs/errors.js";
import type { JobRecord } from "../../src/jobs/schemas.js";
import { makeFailure } from "../../src/providers/failures.js";
import { deterministicPng } from "../../src/providers/mock/deterministic-fixtures.js";

vi.mock("../../src/pdf/character-sheet.js", () => ({
  renderCharacterSheetPdf: vi.fn(async () => Buffer.from("%PDF-synthetic")),
}));

const at = "2026-07-14T00:00:00.000Z";
const hash = "b".repeat(64);
const id = (index: number) => `01J${String(index).padStart(23, "0")}`;
const control = { signal: new AbortController().signal, timeoutMs: 1_000 };

describe("creative job definition boundaries", () => {
  it("enforces exact provider metadata and routes both current-state guards", async () => {
    const fixture = definitions();
    const structured = fixture.definition("story_plan");
    const page = fixture.definition("page_illustration");
    const sheet = fixture.definition("character_sheet_view");
    const finalizer = fixture.definition("character_sheet_finalize");

    expect(() =>
      structured.validateEnqueue(structuredEnqueue() as never),
    ).not.toThrow();
    expect(() => page.validateEnqueue(imageEnqueue())).not.toThrow();
    for (const invalid of [
      { ...structuredEnqueue(), projectId: null },
      { ...structuredEnqueue(), target: null },
      {
        ...structuredEnqueue(),
        target: { ...structuredEnqueue().target, operation: "image" as const },
      },
      { ...structuredEnqueue(), request: imageEnqueue().request },
    ])
      expect(() => structured.validateEnqueue(invalid as never)).toThrowError(
        expect.objectContaining({ code: "CREATIVE_JOB_NOT_BOUND" }),
      );

    const finalizerJob = localJob();
    expect(() => finalizer.validateEnqueue(finalizerJob)).not.toThrow();
    expect(() =>
      finalizer.validateEnqueue({ ...finalizerJob, target: imageTarget }),
    ).toThrowError(expect.objectContaining({ code: "CREATIVE_JOB_NOT_BOUND" }));
    expect(() =>
      finalizer.validateEnqueue({ ...finalizerJob, projectId: null }),
    ).toThrowError(expect.objectContaining({ code: "CREATIVE_JOB_NOT_BOUND" }));

    await structured.prepare(structuredJob(), "structured-batch");
    await page.prepare(imageJob("page_illustration"), "page-batch");
    await sheet.prepare(imageJob("character_sheet_view"), "sheet-batch");
    expect(fixture.pipeline.assertJobCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.sheets.assertJobCurrent).toHaveBeenCalledOnce();
    expect(fixture.preDispatch.prepare).toHaveBeenCalledTimes(3);

    expect(() =>
      structured.commit({
        job: structuredJob(),
        value: { schemaVersion: 1 },
        provenance: null,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" }),
    );
    expect(
      structured.commit({
        job: structuredJob(),
        value: { schemaVersion: 1 },
        provenance,
      }),
    ).toEqual({ resultRefs: [id(90)], provenance });
  });

  it("normalizes validation, capacity, dependency, media, and unknown failures", () => {
    const normalize = definitions().definition("story_plan").normalizeError!;
    let zodError: unknown;
    try {
      z.string().parse(1);
    } catch (error) {
      zodError = error;
    }
    expect(normalize(zodError)).toMatchObject({
      category: "output_validation_failed",
    });

    for (const code of [
      "JOB_PROVIDER_MODEL_UNAVAILABLE",
      "JOB_PROVIDER_OPERATION_UNAVAILABLE",
      "JOB_REFERENCE_LIMIT_UNAVAILABLE",
      "JOB_CHARACTER_LIMIT_UNAVAILABLE",
    ])
      expect(normalize(new JobError(code))).toMatchObject({
        category: "provider_unavailable",
        reasonCode: code,
      });
    for (const code of [
      "JOB_CAPACITY_PLAN_MISMATCH",
      "JOB_CAPABILITY_INPUT_INVALID",
    ])
      expect(normalize(new JobError(code))).toMatchObject({
        category: "invalid_input",
        reasonCode: code,
      });

    expect(
      normalize(new CreativeError("CREATIVE_DEPENDENCY_INCOMPLETE")),
    ).toMatchObject({
      category: "missing_reference_asset",
    });
    expect(
      normalize(new CreativeError("CREATIVE_SHEET_NOT_APPROVED")),
    ).toMatchObject({
      category: "missing_reference_asset",
    });
    expect(
      normalize(new CreativeError("CREATIVE_VERSION_CONFLICT")),
    ).toMatchObject({
      category: "stale_dependency",
    });
    expect(
      normalize(new Error("Input buffer contains unsupported image")),
    ).toMatchObject({
      category: "media_decode_failure",
    });
    expect(normalize(new Error("IMAGE_DIMENSIONS_MISSING"))).toMatchObject({
      category: "media_decode_failure",
    });
    expect(normalize(new Error("OTHER"))).toMatchObject({
      category: "unknown",
    });
    expect(normalize(new JobError("JOB_OTHER"))).toMatchObject({
      category: "unknown",
    });
    expect(normalize("not-an-error")).toMatchObject({ category: "unknown" });
  });

  it("prepares generated bytes once, commits by owner, and discards late output", async () => {
    const fixture = definitions();
    const page = fixture.definition("page_illustration");
    const sheet = fixture.definition("character_sheet_view");
    const pageJob = imageJob("page_illustration");
    const successful = await page.execute({
      job: pageJob,
      prepared: {},
      ...control,
    });
    expect(successful).toMatchObject({ ok: true, provenance });
    if (!successful.ok) throw new Error("EXPECTED_IMAGE_SUCCESS");
    const generatedInput = fixture.assets.prepare.mock.calls[0][0];
    expect(generatedInput).toMatchObject({
      mime: "image/png",
      role: "illustration",
      width: 1,
      height: 1,
      provenance: {
        inputVersionRefs: { validRef: id(31) },
        settingsSnapshot: {
          styleId: "modern_cartoon",
          referenceBudget: 0,
        },
      },
    });
    expect(generatedInput.provenance.inputVersionRefs).not.toHaveProperty(
      "bad-key",
    );

    expect(
      page.commit({ job: pageJob, value: successful.value, provenance }),
    ).toEqual({ resultRefs: [id(91), id(50)], provenance });
    expect(fixture.pipeline.commitIllustration).toHaveBeenCalledOnce();

    const sheetResult = await sheet.execute({
      job: imageJob("character_sheet_view"),
      prepared: {},
      ...control,
    });
    if (!sheetResult.ok) throw new Error("EXPECTED_IMAGE_SUCCESS");
    expect(
      sheet.commit({
        job: imageJob("character_sheet_view"),
        value: sheetResult.value,
        provenance,
      }),
    ).toEqual({ resultRefs: [id(50)], provenance });
    await sheet.discard?.(sheetResult.value);
    expect(fixture.assets.discardPrepared).toHaveBeenCalledOnce();
  });

  it("returns provider failure unchanged and rejects missing provenance or image request", async () => {
    const fixture = definitions();
    const page = fixture.definition("page_illustration");
    fixture.gateway.execute.mockResolvedValueOnce({
      ok: false,
      failure: makeFailure("safety_refusal"),
    });
    await expect(
      page.execute({
        job: imageJob("page_illustration"),
        prepared: {},
        ...control,
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { category: "safety_refusal" },
    });

    fixture.gateway.execute.mockResolvedValueOnce({
      ok: true,
      value: imageResult,
    });
    await expect(
      page.execute({
        job: imageJob("page_illustration"),
        prepared: {},
        ...control,
      }),
    ).rejects.toMatchObject({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" });

    fixture.gateway.execute.mockResolvedValueOnce({
      ok: true,
      value: imageResult,
      provenance,
    });
    await expect(
      page.execute({
        job: { ...imageJob("page_illustration"), request: localRequest },
        prepared: {},
        ...control,
      }),
    ).rejects.toMatchObject({ code: "CREATIVE_JOB_NOT_BOUND" });
  });

  it("finalizes only complete sheet-view dependencies and preserves optional provenance", async () => {
    const fixture = definitions();
    const finalizer = fixture.definition("character_sheet_finalize");
    const prepared = await finalizer.prepare(localJob(), "local-batch");
    expect(prepared).toMatchObject({
      intentId: id(60),
      expectedRevision: 3,
      provenanceByView: {
        front: provenance,
        threeQuarter: provenance,
        fullBody: provenance,
        mainOutfit: provenance,
      },
    });
    expect(prepared).not.toHaveProperty("provenanceByView.face");

    fixture.assets.get.mockImplementation((assetId: string) => ({
      id: assetId,
      role: "sheet_view",
      mime: assetId === id(75) ? "image/jpeg" : "image/png",
    }));
    const execution = await finalizer.execute({
      job: localJob(),
      prepared,
      ...control,
    });
    expect(execution).toMatchObject({ ok: true, value: { pdf: pdfPrepared } });
    if (!execution.ok) throw new Error("EXPECTED_FINALIZER_SUCCESS");
    expect(
      finalizer.commit({
        job: localJob(),
        value: execution.value,
        provenance: null,
      }),
    ).toEqual({ resultRefs: [id(62), id(55), id(63), id(64)] });
    await finalizer.discard?.(execution.value);
    expect(fixture.scheduler.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "human_gate",
        request: expect.objectContaining({ gateKind: "character_approval" }),
      }),
    );
  });

  it("fails finalization on missing jobs, incomplete results, or unsafe MIME", async () => {
    const missingJob = definitions({ missingViewJob: true });
    expect(() =>
      missingJob
        .definition("character_sheet_finalize")
        .prepare(localJob(), "batch"),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" }),
    );

    const incomplete = definitions({ dependencyState: "failed" });
    expect(() =>
      incomplete
        .definition("character_sheet_finalize")
        .prepare(localJob(), "batch"),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" }),
    );

    const unsafe = definitions();
    const finalizer = unsafe.definition("character_sheet_finalize");
    const prepared = await finalizer.prepare(localJob(), "batch");
    unsafe.assets.get.mockImplementation((assetId: string) => ({
      id: assetId,
      role: "sheet_view",
      mime: "application/octet-stream",
    }));
    await expect(
      finalizer.execute({ job: localJob(), prepared, ...control }),
    ).rejects.toMatchObject({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" });
  });
});

const imageTarget = {
  providerId: "mock" as const,
  modelId: "mock-image-v1",
  operation: "image" as const,
  settingsHash: hash,
};
const structuredTarget = {
  providerId: "mock" as const,
  modelId: "mock-v1",
  operation: "structured" as const,
  settingsHash: hash,
};
const imageRequest = {
  kind: "image" as const,
  request: {
    styleId: "modern_cartoon" as const,
    scene: {
      pageNumber: 1,
      description: "مشهد اصطناعي",
      participants: [],
      environment: "حديقة",
      composition: "متوازن",
      cameraFraming: "متوسط",
    },
    referenceImages: [],
    negativeConstraints: ["لا كتابة"],
    output: { minWidthPx: 512, minHeightPx: 512 },
  },
};
const structuredRequest = {
  kind: "structured" as const,
  request: {
    schemaId: "StoryPlan",
    task: {},
    languageDirectives: {},
  },
};
const localRequest = { kind: "local" as const, payloadHash: hash };
const imageResult = {
  imageBytes: deterministicPng(hash),
  mime: "image/png" as const,
};
const provenance = {
  provider: "mock" as const,
  modelId: "mock-image-v1",
  at,
  inputVersionRefs: { validRef: id(31), "bad-key": id(32), short: "bad" },
  promptVersion: "mock-v1",
  referenceAssetIds: [],
  attempt: 1,
  settingsSnapshotHash: hash,
};
const pdfPrepared = { record: { id: id(55) }, isNew: true };

function imageJob(jobType: "page_illustration" | "character_sheet_view") {
  return {
    id: id(jobType === "page_illustration" ? 1 : 2),
    jobType,
    projectId: id(10),
    target: imageTarget,
    request: imageRequest,
    inputSnapshot: {
      run: id(30),
      validRef: id(31),
      "bad-key": id(32),
      short: "bad",
    },
    priority: 3,
  } as unknown as JobRecord;
}

function structuredJob() {
  return {
    id: id(3),
    jobType: "story_plan",
    projectId: id(10),
    target: structuredTarget,
    request: structuredRequest,
    inputSnapshot: { run: id(30) },
    priority: 3,
  } as unknown as JobRecord;
}

function localJob() {
  return {
    id: id(4),
    jobType: "character_sheet_finalize",
    projectId: id(10),
    target: null,
    request: localRequest,
    inputSnapshot: { intent: id(60) },
    priority: 3,
  } as unknown as JobRecord;
}

function imageEnqueue() {
  return {
    jobType: "page_illustration",
    projectId: id(10),
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: "image-intent",
    target: imageTarget,
    request: imageRequest,
    inputSnapshot: {},
  };
}

function structuredEnqueue() {
  return {
    jobType: "story_plan",
    projectId: id(10),
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: "structured-intent",
    target: structuredTarget,
    request: structuredRequest,
    inputSnapshot: {},
  };
}

function definitions(
  options: {
    missingViewJob?: boolean;
    dependencyState?: "succeeded" | "failed";
  } = {},
) {
  const pipeline = {
    assertJobCurrent: vi.fn(),
    commitStructured: vi.fn(() => ({ resultRefs: [id(90)], provenance })),
    commitIllustration: vi.fn(() => ({
      resultRefs: [id(91), id(50)],
      provenance,
    })),
  };
  const viewJobIds = {
    face: options.missingViewJob ? null : id(70),
    front: id(71),
    threeQuarter: id(72),
    fullBody: id(73),
    mainOutfit: id(74),
  };
  const sheets = {
    assertJobCurrent: vi.fn(),
    getIntent: vi.fn(() => ({
      id: id(60),
      revision: 3,
      characterName: "نور",
      referenceThumbnailAssetIds: [id(75)],
      viewJobIds,
    })),
    commitReadySheet: vi.fn(() => ({
      sheet: { id: id(62), projectId: id(10) },
      intent: { id: id(60), revision: 4 },
    })),
    bindApprovalGate: vi.fn(() => ({ id: id(64) })),
  };
  const assets = {
    prepare: vi.fn(async (input) =>
      input.mime === "application/pdf"
        ? pdfPrepared
        : { record: { id: id(50) }, isNew: true },
    ),
    commitPrepared: vi.fn((prepared) => prepared.record),
    discardPrepared: vi.fn(),
    read: vi.fn(async () => deterministicPng(hash)),
    get: vi.fn((assetId: string) => ({
      id: assetId,
      role: "sheet_view",
      mime: assetId === id(75) ? "image/jpeg" : "image/png",
    })),
  };
  const dependencies = Object.values(viewJobIds)
    .filter((jobId): jobId is string => jobId !== null)
    .map((jobId, index) => ({
      id: jobId,
      state: options.dependencyState ?? "succeeded",
      resultRefs: [id(80 + index)],
      provenance: index === 0 ? null : provenance,
    }));
  const scheduler = {
    get: vi.fn(
      (jobId: string) => dependencies.find((job) => job.id === jobId) ?? null,
    ),
    enqueue: vi.fn(() => ({ id: id(63) })),
  };
  const preDispatch = {
    prepare: vi.fn(async (job, guard) => {
      guard.assertCurrent(job);
      return {};
    }),
  };
  const gateway = {
    execute: vi.fn(async (): Promise<unknown> => ({
      ok: true,
      value: imageResult,
      provenance,
    })),
  };
  const created = createCreativeJobDefinitions({
    pipeline: pipeline as never,
    sheets: sheets as never,
    assets: assets as never,
    preDispatch: preDispatch as never,
    gateway: gateway as never,
    scheduler: () => scheduler as never,
  });
  return {
    pipeline,
    sheets,
    assets,
    scheduler,
    preDispatch,
    gateway,
    definition: (jobType: string) =>
      created.find((item) => item.jobType === jobType)!,
  };
}
