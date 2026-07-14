import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStore } from "../../src/assets/asset-store.js";
import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import { CreativeSheetService } from "../../src/domain/creative/sheets.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { humanGateJobRegistration } from "../../src/jobs/registrations.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import type { Provenance } from "../../src/providers/contract.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-14T00:00:00.000Z";
const ids = Array.from(
  { length: 100 },
  (_, index) => `01J${String(index + 1).padStart(23, "0")}`,
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("creative sheet service", () => {
  it("commits five current view assets and one compact PDF as one ready sheet", async () => {
    const fixture = await harness();
    const assets = await sheetAssets(fixture.assets);
    const intent = fixture.service.createIntent(intentInput());
    const bound = fixture.service.bindGenerationJobs({
      intentId: intent.id,
      expectedRevision: intent.revision,
      viewJobIds: viewJobs,
      finalizeJobId: ids[50],
    });
    const result = fixture.service.commitReadySheet({
      intentId: bound.id,
      expectedRevision: bound.revision,
      views: assets.views,
      pdfAssetId: assets.pdf,
      provenanceByView: allViewProvenance(),
    });
    expect(result.sheet).toMatchObject({
      id: intent.sheetId,
      status: "ready",
      appearance: { type: "base", lookId: null, lookVersionId: null },
      generationJobIds: [...Object.values(viewJobs), ids[50]],
    });
    expect(result.intent.status).toBe("ready");
    fixture.close();
  });

  it("completes the owner gate and resolves an approved base-sheet view", async () => {
    const fixture = await harness();
    const assets = await sheetAssets(fixture.assets);
    const ready = readySheet(fixture, assets);
    const gate = fixture.scheduler.enqueue({
      id: ids[60],
      jobType: "human_gate",
      projectId: ids[1],
      standaloneScopeId: null,
      dependsOn: [],
      priority: 3,
      intentId: "sheet-approval",
      target: null,
      request: {
        kind: "human_gate",
        gateKind: "character_approval",
        targetId: ready.sheet.id,
        targetVersionId: ready.sheet.id,
      },
      inputSnapshot: { sheet: ready.sheet.id },
    });
    const bound = fixture.service.bindApprovalGate({
      intentId: ready.intent.id,
      expectedRevision: ready.intent.revision,
      gateJobId: gate.id,
    });
    const approved = fixture.service.approveSheet({
      sheetId: ready.sheet.id,
      expectedSheetRevision: ready.sheet.revision,
      intentId: bound.id,
      expectedIntentRevision: bound.revision,
      gateJobId: gate.id,
      expectedGateRevision: gate.revision,
      notes: "موافقة العميل",
    });
    expect(approved.sheet.status).toBe("approved");
    expect(fixture.scheduler.get(gate.id)?.state).toBe("succeeded");
    expect(approved.approval).toMatchObject({
      sheetId: ready.sheet.id,
      state: "approved",
      notes: "موافقة العميل",
    });
    const resolved = fixture.service.resolveApprovedSheetReferenceMetadata({
      source: "approved_character_sheet",
      characterSheetId: ready.sheet.id,
      customerId: ids[2],
      familyId: ids[3],
      characterId: ids[4],
      characterVersionId: ids[5],
      appearance: { type: "base", lookId: null, lookVersionId: null },
      sheetAssetId: assets.views.face,
    });
    expect(resolved).toEqual({
      ok: true,
      value: expect.objectContaining({
        sheetAssetId: assets.views.face,
        appearance: { type: "base", lookId: null, lookVersionId: null },
        lineageSource: "description_only",
      }),
    });
    fixture.close();
  });

  it("rejects a mismatched appearance or non-approved sheet reference", async () => {
    const fixture = await harness();
    const assets = await sheetAssets(fixture.assets);
    const ready = readySheet(fixture, assets);
    expect(
      fixture.service.resolveApprovedSheetReferenceMetadata({
        source: "approved_character_sheet",
        characterSheetId: ready.sheet.id,
        customerId: ids[2],
        familyId: ids[3],
        characterId: ids[4],
        characterVersionId: ids[5],
        appearance: {
          type: "shared_look",
          lookId: ids[6],
          lookVersionId: ids[7],
        },
        sheetAssetId: assets.views.face,
      }),
    ).toEqual({ ok: false, code: "SHEET_NOT_APPROVED" });
    fixture.close();
  });

  it("records change-request notes and leaves prior ready bytes untouched", async () => {
    const fixture = await harness();
    const assets = await sheetAssets(fixture.assets);
    const ready = readySheet(fixture, assets);
    const gate = fixture.scheduler.enqueue({
      id: ids[61],
      jobType: "human_gate",
      projectId: ids[1],
      standaloneScopeId: null,
      dependsOn: [],
      priority: 3,
      intentId: "sheet-change-request",
      target: null,
      request: {
        kind: "human_gate",
        gateKind: "character_approval",
        targetId: ready.sheet.id,
        targetVersionId: ready.sheet.id,
      },
      inputSnapshot: { sheet: ready.sheet.id },
    });
    const bound = fixture.service.bindApprovalGate({
      intentId: ready.intent.id,
      expectedRevision: ready.intent.revision,
      gateJobId: gate.id,
    });
    const result = fixture.service.requestChanges({
      sheetId: ready.sheet.id,
      expectedSheetRevision: ready.sheet.revision,
      intentId: bound.id,
      expectedIntentRevision: bound.revision,
      gateJobId: gate.id,
      expectedGateRevision: gate.revision,
      notes: "تعديل شكل الشعر",
    });
    expect(result.sheet).toMatchObject({
      status: "revision_needed",
      views: assets.views,
      pdfAssetId: assets.pdf,
    });
    expect(result.approval).toMatchObject({
      state: "changes_requested",
      notes: "تعديل شكل الشعر",
    });
    expect(result.intent.status).toBe("rejected");
    expect(fixture.scheduler.get(gate.id)?.state).toBe("canceled");
    fixture.close();
  });

  it("rejects incomplete job lineage and invalid ready-sheet assets", async () => {
    const incompleteFixture = await harness();
    const planned = incompleteFixture.service.createIntent(intentInput());
    expect(() =>
      incompleteFixture.service.commitReadySheet({
        intentId: planned.id,
        expectedRevision: planned.revision,
        views: viewJobs,
        pdfAssetId: ids[50],
        provenanceByView: {},
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_RUN_STATE_INVALID" }),
    );
    const incomplete = incompleteFixture.repositories.sheetIntents.update({
      ...planned,
      revision: planned.revision + 1,
      status: "generating",
    });
    expect(() =>
      incompleteFixture.service.commitReadySheet({
        intentId: incomplete.id,
        expectedRevision: incomplete.revision,
        views: viewJobs,
        pdfAssetId: ids[50],
        provenanceByView: {},
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" }),
    );
    incompleteFixture.close();

    const fixture = await harness();
    const assets = await sheetAssets(fixture.assets);
    const intent = fixture.service.createIntent(intentInput());
    expect(() =>
      fixture.service.bindGenerationJobs({
        intentId: intent.id,
        expectedRevision: intent.revision,
        viewJobIds: { ...viewJobs, face: ids[50] },
        finalizeJobId: ids[50],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    const bound = fixture.service.bindGenerationJobs({
      intentId: intent.id,
      expectedRevision: intent.revision,
      viewJobIds: viewJobs,
      finalizeJobId: ids[50],
    });
    expect(() =>
      fixture.service.bindGenerationJobs({
        intentId: bound.id,
        expectedRevision: bound.revision,
        viewJobIds: viewJobs,
        finalizeJobId: ids[50],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_RUN_STATE_INVALID" }),
    );

    expect(() =>
      fixture.service.commitReadySheet({
        intentId: bound.id,
        expectedRevision: bound.revision,
        views: { ...assets.views, front: assets.views.face },
        pdfAssetId: assets.pdf,
        provenanceByView: {},
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    expect(() =>
      fixture.service.commitReadySheet({
        intentId: bound.id,
        expectedRevision: bound.revision,
        views: { ...assets.views, face: assets.pdf },
        pdfAssetId: assets.pdf,
        provenanceByView: {},
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" }),
    );
    expect(() =>
      fixture.service.commitReadySheet({
        intentId: bound.id,
        expectedRevision: bound.revision,
        views: assets.views,
        pdfAssetId: ids[99],
        provenanceByView: {},
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" }),
    );
    fixture.close();
  });

  it("requires an exact live approval gate for decisions", async () => {
    const fixture = await harness();
    const assets = await sheetAssets(fixture.assets);
    const ready = readySheet(fixture, assets);
    expect(() =>
      fixture.service.bindApprovalGate({
        intentId: ready.intent.id,
        expectedRevision: ready.intent.revision,
        gateJobId: ids[99],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_DEPENDENCY_INCOMPLETE" }),
    );
    const wrongGate = enqueueGate(fixture, ids[62], ready.sheet.id, {
      gateKind: "project_approval",
    });
    expect(() =>
      fixture.service.bindApprovalGate({
        intentId: ready.intent.id,
        expectedRevision: ready.intent.revision,
        gateJobId: wrongGate.id,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );

    const gate = enqueueGate(fixture, ids[63], ready.sheet.id);
    const bound = fixture.service.bindApprovalGate({
      intentId: ready.intent.id,
      expectedRevision: ready.intent.revision,
      gateJobId: gate.id,
    });
    expect(() =>
      fixture.service.requestChanges({
        sheetId: ready.sheet.id,
        expectedSheetRevision: ready.sheet.revision,
        intentId: bound.id,
        expectedIntentRevision: bound.revision,
        gateJobId: gate.id,
        expectedGateRevision: gate.revision,
        notes: "   ",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_APPROVAL_NOT_APPLICABLE" }),
    );
    expect(() =>
      fixture.service.requestChanges({
        sheetId: ready.sheet.id,
        expectedSheetRevision: ready.sheet.revision,
        intentId: bound.id,
        expectedIntentRevision: bound.revision,
        gateJobId: gate.id,
        expectedGateRevision: gate.revision + 1,
        notes: "تعديل",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_APPROVAL_NOT_APPLICABLE" }),
    );
    expect(() => fixture.service.getSheet(ids[99])).toThrowError(
      expect.objectContaining({ code: "CREATIVE_ENTITY_NOT_FOUND" }),
    );
    expect(() => fixture.service.getIntent(ids[99])).toThrowError(
      expect.objectContaining({ code: "CREATIVE_ENTITY_NOT_FOUND" }),
    );
    fixture.close();
  });

  it("rejects stale sheet-job snapshots before provider work", async () => {
    const fixture = await harness();
    const intent = fixture.service.createIntent(intentInput());
    const bound = fixture.service.bindGenerationJobs({
      intentId: intent.id,
      expectedRevision: intent.revision,
      viewJobIds: viewJobs,
      finalizeJobId: ids[50],
    });
    const current = {
      id: viewJobs.face,
      jobType: "character_sheet_view",
      inputSnapshot: {
        intent: bound.id,
        intentRevision: `r${bound.revision}`,
        characterVersion: bound.characterVersionId,
        view: "face",
      },
    };
    fixture.service.assertJobCurrent(current);
    const staleJobs: Array<{
      id: string;
      jobType: string;
      inputSnapshot: Record<string, string>;
    }> = [
      { ...current, inputSnapshot: {} },
      {
        ...current,
        inputSnapshot: { ...current.inputSnapshot, intentRevision: "r0" },
      },
      {
        ...current,
        inputSnapshot: { ...current.inputSnapshot, characterVersion: ids[99] },
      },
      {
        ...current,
        inputSnapshot: { ...current.inputSnapshot, view: "front" },
      },
      {
        ...current,
        id: ids[99],
        jobType: "character_sheet_finalize",
        inputSnapshot: {
          intent: bound.id,
          intentRevision: `r${bound.revision}`,
          characterVersion: bound.characterVersionId,
        },
      },
    ];
    for (const stale of staleJobs) {
      expect(() => fixture.service.assertJobCurrent(stale)).toThrowError();
    }
    fixture.service.assertJobCurrent({
      id: ids[50],
      jobType: "character_sheet_finalize",
      inputSnapshot: {
        intent: bound.id,
        intentRevision: `r${bound.revision}`,
        characterVersion: bound.characterVersionId,
      },
    });

    const sharedIntent = fixture.service.createIntent({
      ...intentInput(),
      id: ids[6],
      sheetId: ids[7],
      characterId: ids[8],
      characterVersionId: ids[9],
      appearance: {
        type: "shared_look",
        lookId: ids[11],
        lookVersionId: ids[12],
      },
    });
    const sharedBound = fixture.service.bindGenerationJobs({
      intentId: sharedIntent.id,
      expectedRevision: sharedIntent.revision,
      viewJobIds: {
        face: ids[51],
        front: ids[52],
        threeQuarter: ids[53],
        fullBody: ids[54],
        mainOutfit: ids[55],
      },
      finalizeJobId: ids[56],
    });
    expect(() =>
      fixture.service.assertJobCurrent({
        id: ids[51],
        jobType: "character_sheet_view",
        inputSnapshot: {
          intent: sharedBound.id,
          intentRevision: `r${sharedBound.revision}`,
          characterVersion: sharedBound.characterVersionId,
          lookVersion: ids[99],
          view: "face",
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    fixture.close();
  });

  it("rejects every cross-scope sheet reference and missing or wrong-role bytes", async () => {
    const fixture = await harness();
    const assets = await sheetAssets(fixture.assets);
    const approved = approveReadySheet(fixture, assets, ids[64]);
    const reference = {
      source: "approved_character_sheet" as const,
      characterSheetId: approved.sheet.id,
      customerId: ids[2],
      familyId: ids[3],
      characterId: ids[4],
      characterVersionId: ids[5],
      appearance: { type: "base" as const, lookId: null, lookVersionId: null },
      sheetAssetId: assets.views.face,
    };
    for (const mismatch of [
      { customerId: ids[90] },
      { familyId: ids[91] },
      { characterId: ids[92] },
      { characterVersionId: ids[93] },
      {
        appearance: {
          type: "shared_look" as const,
          lookId: ids[94],
          lookVersionId: ids[95],
        },
      },
      { sheetAssetId: ids[96] },
    ]) {
      expect(
        fixture.service.resolveApprovedSheetReferenceMetadata({
          ...reference,
          ...mismatch,
        }),
      ).toEqual({ ok: false, code: "SHEET_REFERENCE_MISMATCH" });
    }

    await fixture.assets.release(assets.views.face);
    expect(
      fixture.service.resolveApprovedSheetReferenceMetadata(reference),
    ).toEqual({ ok: false, code: "SHEET_REFERENCE_MISMATCH" });

    fixture.repositories.sheets.update({
      ...approved.sheet,
      revision: approved.sheet.revision + 1,
      views: { ...approved.sheet.views, front: assets.pdf },
    });
    expect(
      fixture.service.resolveApprovedSheetReferenceMetadata({
        ...reference,
        sheetAssetId: assets.pdf,
      }),
    ).toEqual({ ok: false, code: "SHEET_REFERENCE_MISMATCH" });
    fixture.close();
  });
});

async function harness() {
  const temp = await temporaryDirectory("hekayati-sheets-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "creative.db"));
  const assets = new AssetStore(store, join(temp.path, "assets"));
  const scheduler = new JobScheduler(store, {
    registeredJobs: [humanGateJobRegistration("human_gate")],
    nowIso: () => at,
  });
  let cursor = 70;
  return {
    store,
    assets,
    scheduler,
    repositories: new CreativeRepositories(store),
    service: new CreativeSheetService(store, assets, scheduler, {
      now: () => at,
      idFactory: () => ids[cursor++],
    }),
    close: () => store.close(),
  };
}

function readySheet(
  fixture: Awaited<ReturnType<typeof harness>>,
  assets: Awaited<ReturnType<typeof sheetAssets>>,
) {
  const intent = fixture.service.createIntent(intentInput());
  const bound = fixture.service.bindGenerationJobs({
    intentId: intent.id,
    expectedRevision: intent.revision,
    viewJobIds: viewJobs,
    finalizeJobId: ids[50],
  });
  return fixture.service.commitReadySheet({
    intentId: bound.id,
    expectedRevision: bound.revision,
    views: assets.views,
    pdfAssetId: assets.pdf,
    provenanceByView: allViewProvenance(),
  });
}

function enqueueGate(
  fixture: Awaited<ReturnType<typeof harness>>,
  id: string,
  sheetId: string,
  request: Partial<{
    gateKind: string;
    targetId: string;
    targetVersionId: string;
  }> = {},
) {
  return fixture.scheduler.enqueue({
    id,
    jobType: "human_gate",
    projectId: ids[1],
    standaloneScopeId: null,
    dependsOn: [],
    priority: 3,
    intentId: `gate-${id}`,
    target: null,
    request: {
      kind: "human_gate",
      gateKind: request.gateKind ?? "character_approval",
      targetId: request.targetId ?? sheetId,
      targetVersionId: request.targetVersionId ?? sheetId,
    },
    inputSnapshot: { sheet: sheetId },
  });
}

function approveReadySheet(
  fixture: Awaited<ReturnType<typeof harness>>,
  assets: Awaited<ReturnType<typeof sheetAssets>>,
  gateId: string,
) {
  const ready = readySheet(fixture, assets);
  const gate = enqueueGate(fixture, gateId, ready.sheet.id);
  const bound = fixture.service.bindApprovalGate({
    intentId: ready.intent.id,
    expectedRevision: ready.intent.revision,
    gateJobId: gate.id,
  });
  return fixture.service.approveSheet({
    sheetId: ready.sheet.id,
    expectedSheetRevision: ready.sheet.revision,
    intentId: bound.id,
    expectedIntentRevision: bound.revision,
    gateJobId: gate.id,
    expectedGateRevision: gate.revision,
    notes: "موافقة",
  });
}

function intentInput() {
  return {
    id: ids[0],
    sheetId: ids[10],
    projectId: ids[1],
    customerId: ids[2],
    familyId: ids[3],
    characterId: ids[4],
    characterVersionId: ids[5],
    appearance: { type: "base" as const, lookId: null, lookVersionId: null },
    characterName: "نور",
    styleId: "modern_cartoon" as const,
    referencePhotoIds: [],
    referenceThumbnailAssetIds: [],
    referenceLineage: "description_only" as const,
    revisionNotes: "",
    priorSheetId: null,
  };
}

const viewJobs = {
  face: ids[40],
  front: ids[41],
  threeQuarter: ids[42],
  fullBody: ids[43],
  mainOutfit: ids[44],
};

async function sheetAssets(assets: AssetStore) {
  const entries = await Promise.all(
    (["face", "front", "threeQuarter", "fullBody", "mainOutfit"] as const).map(
      async (view, index) =>
        [
          view,
          (
            await assets.put({
              bytes: Buffer.from(`synthetic-${view}`, "utf8"),
              extension: "png",
              mime: "image/png",
              role: "sheet_view",
              origin: "generated",
              provenance: assetProvenance(ids[40 + index]),
            })
          ).id,
        ] as const,
    ),
  );
  const pdf = await assets.put({
    bytes: Buffer.from("%PDF-synthetic", "utf8"),
    extension: "pdf",
    mime: "application/pdf",
    role: "pdf_preview",
    origin: "derived",
  });
  return {
    views: Object.fromEntries(entries) as Record<
      (typeof entries)[number][0],
      string
    >,
    pdf: pdf.id,
  };
}

function allViewProvenance() {
  return {
    face: provenance,
    front: provenance,
    threeQuarter: provenance,
    fullBody: provenance,
    mainOutfit: provenance,
  };
}

function assetProvenance(jobId: string) {
  return {
    provider: "mock" as const,
    model: "mock-image-v1",
    at,
    jobId,
    inputVersionRefs: { characterVersion: ids[5] },
    promptVersion: "mock-v1",
    referencedAssetIds: [],
    attempt: 1,
    settingsSnapshot: {
      schemaVersion: 1 as const,
      settingsHash: "f".repeat(64),
      styleId: "modern_cartoon",
    },
  };
}

const provenance: Provenance = {
  provider: "mock",
  modelId: "mock-image-v1",
  at,
  inputVersionRefs: { characterVersion: ids[5] },
  promptVersion: "mock-v1",
  referenceAssetIds: [],
  attempt: 1,
  settingsSnapshotHash: "f".repeat(64),
};
