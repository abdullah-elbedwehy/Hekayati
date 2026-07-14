import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { createRuntime } from "../../src/server/app.js";
import { deterministicStructuredFixture } from "../../src/providers/mock/deterministic-fixtures.js";
import {
  seedCreativeProject,
  waitForValue,
} from "../helpers/creative-fixtures.js";
import { httpRequest } from "../helpers/http.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("creative local API", () => {
  it("wires the durable graph and enforces family scope on every read", async () => {
    const directory = await temporaryDirectory("hekayati-creative-api-");
    cleanups.push(directory.cleanup);
    const seeded = await seedCreativeProject(directory.path);
    const foreign = await seedCreativeProject(directory.path, " أخرى");
    const runtime = await createRuntime({
      dataDir: directory.path,
      serveUi: false,
      jobs: { pollIntervalMs: 2 },
      providers: { mockStructuredFixture: structuredFixtureWithBlock },
    });
    cleanups.push(() => runtime.close());
    const origin = await runtime.start();
    const bootstrap = await getJson(origin, "/api/bootstrap");
    const fixture = { origin, csrf: String(bootstrap.csrfToken) };

    const started = await mutate(
      fixture,
      `/api/creative/projects/${seeded.projectId}/sheets?familyId=${seeded.scope.familyId}`,
      {
        characterId: seeded.characterId,
        expectedProjectVersionId: seeded.projectVersionId,
      },
    );
    expect(started.status).toBe(200);
    const intentId = JSON.parse(started.body).intent.id as string;
    const intent = await waitForValue(() => {
      const current = runtime.creative.sheets.getIntent(intentId);
      return current.status === "ready" && current.approvalGateJobId
        ? current
        : null;
    });
    const sheet = runtime.creative.sheets.getSheet(intent.sheetId);
    const pdf = await httpRequest(
      origin,
      `/api/creative/sheets/${sheet.id}/pdf?familyId=${seeded.scope.familyId}`,
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    const face = await httpRequest(
      origin,
      `/api/creative/sheets/${sheet.id}/views/face?familyId=${seeded.scope.familyId}`,
    );
    expect(face.status).toBe(200);
    expect(face.headers["content-type"]).toContain("image/png");
    expect(face.headers["cache-control"]).toBe("private, no-store");
    expect(
      (
        await httpRequest(
          origin,
          `/api/creative/sheets/${sheet.id}/views/face?familyId=${foreign.scope.familyId}`,
        )
      ).status,
    ).toBe(403);
    const foreignRead = await httpRequest(
      origin,
      `/api/creative/sheets/${sheet.id}?familyId=${foreign.scope.familyId}`,
    );
    expect(foreignRead.status).toBe(403);

    const gate = runtime.jobs.scheduler.get(intent.approvalGateJobId!)!;
    const approval = await mutate(
      fixture,
      `/api/creative/sheets/${sheet.id}/approve?familyId=${seeded.scope.familyId}`,
      {
        expectedSheetRevision: sheet.revision,
        intentId: intent.id,
        expectedIntentRevision: intent.revision,
        gateJobId: gate.id,
        expectedGateRevision: gate.revision,
        notes: "اعتماد اصطناعي",
      },
    );
    expect(approval.status).toBe(200);
    const runResponse = await mutate(
      fixture,
      `/api/creative/projects/${seeded.projectId}/runs?familyId=${seeded.scope.familyId}`,
      {
        expectedProjectVersionId: seeded.projectVersionId,
        expectedStoryVersionId: seeded.storyVersionId,
      },
    );
    expect(runResponse.status).toBe(200);
    const runId = JSON.parse(runResponse.body).run.id as string;
    const run = await waitForValue(() => {
      const current = runtime.creative.pipeline.getRun(runId);
      return current.status === "internal_review" ? current : null;
    });

    expect(
      (await httpRequest(origin, `/api/creative/runs/${run.id}`)).status,
    ).toBe(400);
    expect(
      (
        await httpRequest(
          origin,
          `/api/creative/runs/${run.id}?familyId=${foreign.scope.familyId}`,
        )
      ).status,
    ).toBe(403);
    const findings = await httpRequest(
      origin,
      `/api/creative/runs/${run.id}/findings?familyId=${seeded.scope.familyId}`,
    );
    expect(findings.status).toBe(200);
    const findingList = JSON.parse(findings.body) as Array<{
      key: string;
      severity: string;
      acknowledged: boolean;
    }>;
    expect(findingList).toHaveLength(1);
    expect(findingList[0]).toMatchObject({
      severity: "block",
      acknowledged: false,
    });
    const staleAcknowledgement = await mutate(
      fixture,
      `/api/creative/runs/${run.id}/findings/acknowledge?familyId=${seeded.scope.familyId}`,
      {
        expectedRunRevision: run.revision + 1,
        findingKey: findingList[0].key,
        note: "إقرار اصطناعي",
      },
    );
    expect(staleAcknowledgement.status).toBe(409);
    const acknowledgement = await mutate(
      fixture,
      `/api/creative/runs/${run.id}/findings/acknowledge?familyId=${seeded.scope.familyId}`,
      {
        expectedRunRevision: run.revision,
        findingKey: findingList[0].key,
        note: "راجعه المشغّل اصطناعيًا",
      },
    );
    expect(acknowledgement.status).toBe(200);
    const acknowledgedFindings = await httpRequest(
      origin,
      `/api/creative/runs/${run.id}/findings?familyId=${seeded.scope.familyId}`,
    );
    expect(JSON.parse(acknowledgedFindings.body)[0].acknowledged).toBe(true);
    const page = runtime.creative.pages
      .listProjectPages(seeded.projectId)
      .find((item) => item.kind === "story")!;
    const image = await httpRequest(
      origin,
      `/api/creative/pages/${page.id}/illustration?familyId=${seeded.scope.familyId}`,
    );
    expect(image.status).toBe(200);
    expect(image.headers["cache-control"]).toBe("private, no-store");
    const priorIllustrationId = page.currentIllustrationVersionId!;
    const regeneration = await mutate(
      fixture,
      `/api/creative/pages/${page.id}/regenerate-illustration?familyId=${seeded.scope.familyId}`,
      { runId: run.id, expectedRevision: page.revision },
    );
    expect(regeneration.status).toBe(200);
    await waitForValue(() => {
      const current = runtime.creative.pages.getPage(page.id);
      return current.currentIllustrationVersionId !== priorIllustrationId
        ? current
        : null;
    });
    expect(
      (
        await httpRequest(
          origin,
          `/api/creative/pages/${page.id}/illustration?familyId=${seeded.scope.familyId}&version=${priorIllustrationId}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await httpRequest(
          origin,
          `/api/creative/pages/${page.id}/illustration?familyId=${foreign.scope.familyId}&version=${priorIllustrationId}`,
        )
      ).status,
    ).toBe(403);

    await exerciseChangeRequest(fixture, runtime, seeded, sheet.id);
    await exerciseAffectedItems(fixture, runtime, seeded, foreign, sheet);
  }, 120_000);
});

async function exerciseChangeRequest(
  fixture: { origin: string; csrf: string },
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  seeded: Awaited<ReturnType<typeof seedCreativeProject>>,
  priorSheetId: string,
) {
  const started = await mutate(
    fixture,
    `/api/creative/projects/${seeded.projectId}/sheets?familyId=${seeded.scope.familyId}`,
    {
      characterId: seeded.characterId,
      expectedProjectVersionId: seeded.projectVersionId,
      priorSheetId,
      revisionNotes: "تجربة تعديل",
    },
  );
  expect(started.status).toBe(200);
  const intentId = JSON.parse(started.body).intent.id as string;
  const intent = await waitForValue(() => {
    const current = runtime.creative.sheets.getIntent(intentId);
    return current.status === "ready" && current.approvalGateJobId
      ? current
      : null;
  });
  const sheet = runtime.creative.sheets.getSheet(intent.sheetId);
  const gate = runtime.jobs.scheduler.get(intent.approvalGateJobId!)!;
  const response = await mutate(
    fixture,
    `/api/creative/sheets/${sheet.id}/change-request?familyId=${seeded.scope.familyId}`,
    {
      expectedSheetRevision: sheet.revision,
      intentId: intent.id,
      expectedIntentRevision: intent.revision,
      gateJobId: gate.id,
      expectedGateRevision: gate.revision,
      expectedProjectVersionId: seeded.projectVersionId,
      notes: "عدّل تسريحة الشعر اصطناعيًا",
    },
  );
  expect(response.status).toBe(200);
  expect(runtime.jobs.scheduler.get(gate.id)?.state).toBe("canceled");
  expect(runtime.creative.sheets.getSheet(sheet.id).status).toBe(
    "revision_needed",
  );
  expect(JSON.parse(response.body).successor.intent.priorSheetId).toBe(
    sheet.id,
  );
}

async function exerciseAffectedItems(
  fixture: { origin: string; csrf: string },
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  seeded: Awaited<ReturnType<typeof seedCreativeProject>>,
  foreign: Awaited<ReturnType<typeof seedCreativeProject>>,
  sheet: ReturnType<typeof runtime.creative.sheets.getSheet>,
) {
  const event = runtime.creative.invalidation.appendEvent({
    id: ulid(),
    entity: "character",
    entityId: seeded.characterId,
    fromVersionId: sheet.characterVersionId,
    toVersionId: ulid(),
    changeType: "permanent_appearance",
    matrixRow: "IM-01",
    changedFields: ["hair"],
    correlationId: ulid(),
  });
  const path = `/api/creative/invalidation-events/${event.id}/affected-items`;
  const jobsBefore = runtime.jobs.scheduler.list().length;
  const foreignResponse = await mutate(
    fixture,
    `${path}?familyId=${foreign.scope.familyId}`,
    {},
  );
  expect(foreignResponse.status).toBe(403);
  expect(runtime.creative.sheets.getSheet(sheet.id).status).toBe("approved");
  const owner = await mutate(
    fixture,
    `${path}?familyId=${seeded.scope.familyId}`,
    {},
  );
  expect(owner.status).toBe(200);
  expect(owner.headers["cache-control"]).toBe("private, no-store");
  const projection = JSON.parse(owner.body);
  expect(projection.affected).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: sheet.id,
        kind: "character_sheet",
        effect: "stale",
      }),
    ]),
  );
  const replay = await mutate(
    fixture,
    `${path}?familyId=${seeded.scope.familyId}`,
    {},
  );
  expect(JSON.parse(replay.body).audit.id).toBe(projection.audit.id);
  expect(runtime.jobs.scheduler.list()).toHaveLength(jobsBefore);
}

function structuredFixtureWithBlock(
  task: Parameters<typeof deterministicStructuredFixture>[0],
  hash: string,
) {
  if (task.schemaId !== "ReviewFindings")
    return deterministicStructuredFixture(task, hash);
  return {
    schemaVersion: 1,
    findings: [
      {
        scope: "page",
        refId: task.payload.artifactRefs[0],
        pageNumber: 1,
        category: "safety",
        severity: "block",
        excerpt: "ملاحظة اصطناعية",
        note: "تتطلب إقرار المشغّل",
      },
    ],
  };
}

async function getJson(
  origin: string,
  path: string,
): Promise<Record<string, unknown>> {
  const response = await httpRequest(origin, path);
  expect(response.status).toBe(200);
  return JSON.parse(response.body) as Record<string, unknown>;
}

function mutate(
  fixture: { origin: string; csrf: string },
  path: string,
  body: unknown,
) {
  return httpRequest(fixture.origin, path, {
    method: "POST",
    headers: {
      origin: fixture.origin,
      "content-type": "application/json",
      "x-hekayati-csrf": fixture.csrf,
    },
    body: JSON.stringify(body),
  });
}
