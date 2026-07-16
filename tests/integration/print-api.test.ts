import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { AssetStore } from "../../src/assets/asset-store.js";
import { resolveDataPaths } from "../../src/config/paths.js";
import { initializeLayoutPersistence } from "../../src/domain/layout/migrations.js";
import type { LayoutProjectProjection } from "../../src/domain/layout/workspace.js";
import { createDefaultPrinterProfileDraft } from "../../src/domain/print/schemas.js";
import type { PrintWorkspaceService } from "../../src/domain/print/workspace.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { createRuntime } from "../../src/server/app.js";
import {
  seedCreativeProject,
  waitForValue,
} from "../helpers/creative-fixtures.js";
import { httpRequest } from "../helpers/http.js";
import { seedReviewedPages } from "../helpers/layout-workflow-fixture.js";
import { syntheticPreviewSource } from "../helpers/preview-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
type PrintProjectProjection = ReturnType<PrintWorkspaceService["project"]>;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("print production API boundary", () => {
  it("scopes profile assignment, start, state and deliverable bytes", async () => {
    const fixture = await startFixture();
    const draft = {
      ...createDefaultPrinterProfileDraft(),
      spine: { source: "explicit" as const, widthMm: 8 },
    };

    const forged = await jsonMutation(
      fixture,
      "/api/print/profiles",
      { name: "مرفوض", draft },
      "POST",
      "wrong-token",
    );
    expect(forged.status).toBe(403);
    expect(fixture.runtime.print.profiles.list()).toEqual([]);

    const unknownField = await jsonMutation(
      fixture,
      "/api/print/profiles",
      { name: "مرفوض", draft: { ...draft, sourcePath: "/tmp/profile" } },
      "POST",
    );
    expect(unknownField.status).toBe(400);
    expect(unknownField.body).not.toContain("/tmp/profile");

    const createdResponse = await jsonMutation(
      fixture,
      "/api/print/profiles",
      { name: "طابعة اصطناعية آمنة", draft },
      "POST",
    );
    expect(createdResponse.status).toBe(200);
    expect(createdResponse.headers["cache-control"]).toBe("private, no-store");
    const created = JSON.parse(createdResponse.body) as ReturnType<
      typeof fixture.runtime.print.profiles.create
    >;
    expect(created.version).toMatchObject({ readiness: "ready" });

    const projectPath = `/api/print/projects/${fixture.seed.projectId}`;
    const wrongScope = await jsonMutation(
      fixture,
      `${projectPath}/profile?familyId=${fixture.foreign.scope.familyId}`,
      assignmentBody(fixture, created),
      "POST",
    );
    expect(wrongScope.status).toBe(404);
    expect(
      fixture.runtime.print.workspace.project(
        fixture.seed.scope,
        fixture.seed.projectId,
      ).project.printerProfileId,
    ).toBeNull();

    const assigned = await jsonMutation(
      fixture,
      `${projectPath}/profile?familyId=${fixture.seed.scope.familyId}`,
      assignmentBody(fixture, created),
      "POST",
    );
    expect(assigned.status).toBe(200);
    const authorization = await approvedSnapshotStatus(fixture);

    const project = fixture.runtime.print.workspace.project(
      fixture.seed.scope,
      fixture.seed.projectId,
    );
    const badStart = await jsonMutation(
      fixture,
      `${projectPath}/runs?familyId=${fixture.seed.scope.familyId}`,
      startBody(project, created, "f".repeat(64), "bad-start"),
      "POST",
    );
    expect(badStart.status).toBe(422);
    expect(fixture.runtime.jobs.scheduler.list().filter(isPrintJob)).toEqual(
      [],
    );

    const start = startBody(
      project,
      created,
      authorization.contentAuthorizationHash,
      "api-start",
    );
    const started = await jsonMutation(
      fixture,
      `${projectPath}/runs?familyId=${fixture.seed.scope.familyId}`,
      start,
      "POST",
    );
    expect(started.status).toBe(200);
    expect(started.headers["cache-control"]).toBe("private, no-store");
    const replay = await jsonMutation(
      fixture,
      `${projectPath}/runs?familyId=${fixture.seed.scope.familyId}`,
      start,
      "POST",
    );
    expect(JSON.parse(replay.body)).toMatchObject({ replayed: true });
    const startedRun = (JSON.parse(started.body) as { run: { id: string } })
      .run;

    const settled = await waitForValue(
      () => {
        const current = fixture.runtime.print.workspace.project(
          fixture.seed.scope,
          fixture.seed.projectId,
        );
        const jobs = fixture.runtime.jobs.scheduler
          .list()
          .filter(isPrintJob)
          .map((job) => ({
            jobType: job.jobType,
            state: job.state,
            failure: job.failure,
          }));
        const terminalRun = [
          "deliverable",
          "blocked",
          "rejected",
          "stale",
        ].includes(current.run?.state ?? "");
        return current.run?.id === startedRun.id &&
          (terminalRun || jobs.some((job) => job.state === "failed"))
          ? { current, jobs }
          : null;
      },
      90_000,
      () =>
        JSON.stringify(
          fixture.runtime.jobs.scheduler.list().filter(isPrintJob),
        ),
    );
    expect(
      settled.current.run?.state,
      JSON.stringify({ jobs: settled.jobs, report: settled.current.report }),
    ).toBe("deliverable");
    const deliverable = settled.current;
    expect(deliverable.report).toMatchObject({ passed: true, findings: [] });

    for (const kind of ["interior", "cover"] as const) {
      const path = `/api/print/runs/${startedRun.id}/download/${kind}?familyId=${fixture.seed.scope.familyId}`;
      const download = await httpRequest(fixture.origin, path);
      expect(download.status).toBe(200);
      expect(download.headers["cache-control"]).toBe("private, no-store");
      expect(download.headers["content-type"]).toContain("application/pdf");
      expect(download.headers["content-disposition"]).toContain("attachment");
      expect(download.headers["x-content-type-options"]).toBe("nosniff");
      expect(Buffer.byteLength(download.body)).toBeGreaterThan(1_000);
      const foreign = await httpRequest(
        fixture.origin,
        path.replace(
          fixture.seed.scope.familyId,
          fixture.foreign.scope.familyId,
        ),
      );
      expect(foreign.status).toBe(404);
      expect(Buffer.byteLength(foreign.body)).toBeLessThan(500);
    }
    const injected = await httpRequest(
      fixture.origin,
      `/api/print/runs/${encodeURIComponent("../../etc/passwd")}/download/interior?familyId=${fixture.seed.scope.familyId}`,
    );
    expect(injected.status).toBe(400);
    expect(injected.body).not.toContain("/etc/passwd");
  }, 150_000);
});

async function startFixture() {
  const directory = await temporaryDirectory("hekayati-print-api-");
  cleanups.push(directory.cleanup);
  const seed = await seedCreativeProject(directory.path, "-print-api");
  const foreign = await seedCreativeProject(directory.path, "-print-foreign");
  const paths = resolveDataPaths(directory.path);
  const store = new DocumentStore(paths.database);
  initializeLayoutPersistence(store);
  const assets = new AssetStore(store, paths.assets);
  const sourceBytes = await sharp(await syntheticPreviewSource())
    .resize(2_600, 3_677, { fit: "fill" })
    .png()
    .toBuffer();
  const source = await assets.put({
    bytes: sourceBytes,
    extension: "png",
    mime: "image/png",
    role: "illustration",
    origin: "derived",
    width: 2_600,
    height: 3_677,
    dpi: 300,
  });
  seedReviewedPages(store, seed.projectId, source.id);
  store.close();
  const runtime = await createRuntime({
    dataDir: directory.path,
    serveUi: false,
    jobs: { pollIntervalMs: 2, maxWorkers: 2 },
  });
  cleanups.push(() => runtime.close());
  const origin = await runtime.start();
  const bootstrap = JSON.parse(
    (await httpRequest(origin, "/api/bootstrap")).body,
  ) as { csrfToken: string };
  runtime.layout.workflow.start(seed.projectId);
  await waitForValue(() => {
    const current = runtime.layout.workspace.project(seed.projectId);
    return current.workflow?.state === "ready" ? current : null;
  }, 90_000);
  const fixture = {
    directory,
    seed,
    foreign,
    runtime,
    origin,
    csrf: bootstrap.csrfToken,
  };
  await approveProject(fixture);
  return fixture;
}

async function approveProject(fixture: {
  seed: { projectId: string; scope: { familyId: string } };
  origin: string;
  csrf: string;
  runtime: Awaited<ReturnType<typeof createRuntime>>;
}): Promise<void> {
  let state = fixture.runtime.layout.workspace.project(fixture.seed.projectId);
  await approvalMutation(fixture, state, "sent", "print-send");
  state = fixture.runtime.layout.workspace.project(fixture.seed.projectId);
  await approvalMutation(fixture, state, "approve", "print-approve");
}

function approvalMutation(
  fixture: {
    seed: { scope: { familyId: string } };
    origin: string;
    csrf: string;
  },
  state: LayoutProjectProjection,
  route: "sent" | "approve",
  idempotencyKey: string,
) {
  return jsonMutation(
    fixture,
    `/api/layout/previews/${state.preview!.id}/${route}?familyId=${fixture.seed.scope.familyId}`,
    {
      cycleId: state.approval!.id,
      idempotencyKey,
      customerContentHash: state.preview!.customerContentHash,
      approvalBundleHash: state.preview!.approvalBundleHash,
      expectedProjectRevision: state.project.revision,
      expectedPreviewOutputRevision: state.preview!.revision,
      expectedApprovalRevision: state.approval!.revision,
      expectedGateRevision: state.approvalGate!.revision,
      expectedContentApprovalId: state.project.currentContentApprovalId,
      expectedContentApprovalRevision: state.project.currentContentApprovalId
        ? state.contentApproval!.revision
        : null,
    },
    "POST",
  );
}

function assignmentBody(
  fixture: Awaited<ReturnType<typeof startFixture>>,
  profile: ReturnType<typeof fixture.runtime.print.profiles.create>,
) {
  const project = fixture.runtime.print.workspace.project(
    fixture.seed.scope,
    fixture.seed.projectId,
  ).project;
  return {
    expectedProjectRevision: project.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
  };
}

async function approvedSnapshotStatus(
  fixture: Awaited<ReturnType<typeof startFixture>>,
) {
  const response = await httpRequest(
    fixture.origin,
    `/api/layout/projects/${fixture.seed.projectId}/approved-snapshot-status?familyId=${fixture.seed.scope.familyId}`,
  );
  const body = JSON.parse(response.body) as {
    state: string;
    snapshot: { contentAuthorizationHash: string };
  };
  expect(body.state).toBe("authorized");
  return body.snapshot;
}

function startBody(
  project: PrintProjectProjection,
  profile: ReturnType<
    Awaited<
      ReturnType<typeof startFixture>
    >["runtime"]["print"]["profiles"]["create"]
  >,
  contentAuthorizationHash: string,
  idempotencyKey: string,
) {
  return {
    expectedProjectRevision: project.project.revision,
    profileId: profile.profile.id,
    expectedProfileRevision: profile.profile.revision,
    profileVersionId: profile.version.id,
    contentAuthorizationHash,
    idempotencyKey,
  };
}

function jsonMutation(
  fixture: { origin: string; csrf: string },
  path: string,
  body: unknown,
  method: "POST" | "PUT",
  csrf = fixture.csrf,
) {
  return httpRequest(fixture.origin, path, {
    method,
    headers: {
      origin: fixture.origin,
      "content-type": "application/json",
      "x-hekayati-csrf": csrf,
    },
    body: JSON.stringify(body),
  });
}

function isPrintJob(job: { jobType: string }): boolean {
  return job.jobType.startsWith("print_");
}
