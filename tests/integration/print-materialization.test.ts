import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { AssetStore } from "../../src/assets/asset-store.js";
import { ApprovedBookSnapshotReader } from "../../src/domain/layout/approvals.js";
import { finalizePrinterProfileVersion } from "../../src/domain/print/schemas.js";
import { PrinterProfileService } from "../../src/domain/print/profiles.js";
import { PrintRepositories } from "../../src/domain/print/repositories.js";
import { PrintProductionService } from "../../src/domain/print/workflow.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { customerContentHash } from "../helpers/layout-approval-fixtures.js";
import {
  expectZeroPrintWork,
  fixedApprovedSnapshot as fixedSnapshot,
  materializationStartInput as startInput,
  printMaterializationScheduler as printScheduler,
  setupMaterializationHarness,
  syntheticIcc,
} from "../helpers/print-materialization-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("print materialization authorization fence", () => {
  it("atomically creates one run and two exact local jobs, then replays", async () => {
    const harness = await setup();
    const input = await startInput(harness, "print-start-1");
    const first = await harness.production.start(input);
    const replay = await harness.production.start(input);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(first.run).toMatchObject({
      state: "queued",
      contentAuthorizationHash: input.contentAuthorizationHash,
      printerProfileId: harness.profile.profile.id,
      printerProfileVersionId: harness.profile.version.id,
    });
    expect(first.jobs.map((job) => job.jobType)).toEqual([
      "print_interior",
      "print_cover",
    ]);
    expect(first.jobs.every((job) => job.request.kind === "local")).toBe(true);
    expect(harness.print.runs.list()).toHaveLength(1);
    expect(
      harness.scheduler
        .list()
        .filter((job) => job.jobType.startsWith("print_")),
    ).toHaveLength(2);

    await expect(
      harness.production.start({
        ...input,
        idempotencyKey: "print-start-bad-auth",
        contentAuthorizationHash: "f".repeat(64),
      }),
    ).rejects.toThrow("PRINT_AUTHORIZATION_MISMATCH");
    expect(harness.print.runs.list()).toHaveLength(1);
    expect(
      harness.scheduler
        .list()
        .filter((job) => job.jobType.startsWith("print_")),
    ).toHaveLength(2);
    harness.store.close();
  });

  it("resolves an exact stored start before mutable revision checks and keeps changed keyed requests conflicting", async () => {
    const harness = await setup();
    const input = await startInput(harness, "print-start-stable-replay");
    const first = await harness.production.start(input);
    const project = harness.fixture.authoring.projects.get(
      harness.fixture.projectId,
    )!;
    harness.fixture.authoring.projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: new Date().toISOString(),
    });

    const replay = await harness.production.start(input);

    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      harness.production.start({
        ...input,
        expectedProjectRevision: input.expectedProjectRevision + 1,
      }),
    ).rejects.toThrow("PRINT_IDEMPOTENCY_COLLISION");
    expect(harness.print.runs.list()).toHaveLength(1);
    expect(
      harness.scheduler
        .list()
        .filter((job) => job.jobType.startsWith("print_")),
    ).toHaveLength(2);
    harness.store.close();
  });

  it("replays the exact persisted start after reopening storage and scheduling", async () => {
    const harness = await setup();
    const input = await startInput(harness, "print-start-reopen-replay");
    const first = await harness.production.start(input);
    harness.store.close();

    const reopenedStore = new DocumentStore(
      join(harness.temp.path, "hekayati.db"),
    );
    try {
      const reopenedAssets = new AssetStore(
        reopenedStore,
        join(harness.temp.path, "assets"),
      );
      const reopenedScheduler = printScheduler(reopenedStore);
      const reopenedReader = new ApprovedBookSnapshotReader(
        reopenedStore,
        reopenedScheduler,
        reopenedAssets,
        { resolveCustomerContentHash: () => customerContentHash },
      );
      const reopenedProduction = new PrintProductionService(
        reopenedStore,
        reopenedAssets,
        reopenedScheduler,
        reopenedReader,
      );

      await expect(reopenedProduction.start(input)).resolves.toEqual({
        ...first,
        replayed: true,
      });
      expect(new PrintRepositories(reopenedStore).runs.list()).toEqual([
        first.run,
      ]);
      expect(
        reopenedScheduler
          .list()
          .filter((job) => job.jobType.startsWith("print_"))
          .sort((left, right) => left.jobType.localeCompare(right.jobType)),
      ).toEqual(
        [...first.jobs].sort((left, right) =>
          left.jobType.localeCompare(right.jobType),
        ),
      );
    } finally {
      reopenedStore.close();
    }
  });

  it("creates zero work when the 008 integrity guard blocks", async () => {
    const harness = await setup();
    harness.integrity.status = "corrupt";
    const project = harness.fixture.authoring.projects.get(
      harness.fixture.projectId,
    )!;
    await expect(
      harness.production.start({
        owner: harness.fixture.owner,
        projectId: project.id,
        expectedProjectRevision: project.revision,
        profileId: harness.profile.profile.id,
        expectedProfileRevision: harness.profile.profile.revision,
        profileVersionId: harness.profile.version.id,
        contentAuthorizationHash: harness.authorizationHash,
        idempotencyKey: "blocked-integrity",
      }),
    ).rejects.toThrow("APPROVED_SNAPSHOT_INTEGRITY_FAILED");
    expect(harness.print.runs.list()).toEqual([]);
    expect(
      harness.scheduler
        .list()
        .filter((job) => job.jobType.startsWith("print_")),
    ).toEqual([]);
    harness.store.close();
  });

  it("rechecks source integrity synchronously after the snapshot read", async () => {
    const harness = await setup();
    const input = await startInput(harness, "integrity-read-transaction-gap");
    const snapshot = await harness.reader.read(harness.fixture.projectId);
    await writeFile(
      harness.assets.pathForRecord(harness.source),
      Buffer.from("corrupt-after-snapshot-read"),
    );
    const production = new PrintProductionService(
      harness.store,
      harness.assets,
      harness.scheduler,
      fixedSnapshot(snapshot),
    );

    await expect(production.start(input)).rejects.toThrow();
    expectZeroPrintWork(harness);
    harness.store.close();
  });

  it("materializes through IM-19-only observation drift", async () => {
    const harness = await setup();
    const output = harness.fixture.layout.previewOutputs.get(
      harness.bundle.output.id,
    )!;
    harness.fixture.layout.previewOutputs.update(output.revision, {
      ...output,
      revision: output.revision + 1,
      updatedAt: new Date().toISOString(),
      status: "stale",
      staleReasons: ["IM-19"],
      invalidatedByEventIds: [ulid()],
    });
    const cycle = harness.fixture.layout.bookApprovalCycles.get(
      harness.bundle.cycle.id,
    )!;
    harness.fixture.layout.bookApprovalCycles.update(cycle.revision, {
      ...cycle,
      revision: cycle.revision + 1,
      updatedAt: new Date().toISOString(),
      attentionReasons: ["IM-19"],
    });
    const input = await startInput(harness, "materialize-after-im-19");

    const result = await harness.production.start(input);

    expect(result.run.contentAuthorizationHash).toBe(
      input.contentAuthorizationHash,
    );
    expect(result.jobs).toHaveLength(2);
    harness.store.close();
  });

  it("rechecks pinned ICC bytes synchronously during materialization", async () => {
    const harness = await setup();
    const profiles = new PrinterProfileService(harness.store, harness.assets);
    const imported = await profiles.importIcc({
      bytes: syntheticIcc("CMYK"),
      requireCmyk: true,
    });
    const current = harness.profile.version;
    const cmyk = profiles.update({
      profileId: harness.profile.profile.id,
      expectedRevision: harness.profile.profile.revision,
      name: harness.profile.profile.name,
      archived: false,
      draft: {
        trim: current.trim,
        bleedMm: current.bleedMm,
        safeContentRegion: current.safeContentRegion,
        dpiMin: current.dpiMin,
        color: {
          mode: "cmyk",
          iccAssetId: imported.asset.id,
          iccChecksum: imported.asset.sha256,
        },
        cropMarks: current.cropMarks,
        spine: current.spine,
        coverTemplate: current.coverTemplate,
        requiredBlankPages: current.requiredBlankPages,
      },
    });
    const project = harness.fixture.authoring.projects.get(
      harness.fixture.projectId,
    )!;
    profiles.assignProject({
      owner: harness.fixture.owner,
      projectId: project.id,
      expectedProjectRevision: project.revision,
      profileId: cmyk.profile.id,
      expectedProfileRevision: cmyk.profile.revision,
      profileVersionId: cmyk.version.id,
    });
    const assigned = harness.fixture.authoring.projects.get(project.id)!;
    await writeFile(
      harness.assets.pathForRecord(imported.asset),
      Buffer.from("corrupt-pinned-icc"),
    );

    await expect(
      harness.production.start({
        owner: harness.fixture.owner,
        projectId: assigned.id,
        expectedProjectRevision: assigned.revision,
        profileId: cmyk.profile.id,
        expectedProfileRevision: cmyk.profile.revision,
        profileVersionId: cmyk.version.id,
        contentAuthorizationHash: harness.authorizationHash,
        idempotencyKey: "corrupt-profile-icc",
      }),
    ).rejects.toThrow("PRINT_RUN_STALE");
    expectZeroPrintWork(harness);
    harness.store.close();
  });

  it("rejects a persisted CMYK profile that pins an imported RGB ICC", async () => {
    const harness = await setup();
    const profiles = new PrinterProfileService(harness.store, harness.assets);
    const imported = await profiles.importIcc({
      bytes: syntheticIcc("RGB "),
      requireCmyk: false,
    });
    const currentProfile = harness.print.profiles.get(
      harness.profile.profile.id,
    )!;
    const currentVersion = harness.print.profileVersions.get(
      currentProfile.currentVersionId,
    )!;
    const at = new Date().toISOString();
    const forgedVersion = finalizePrinterProfileVersion({
      id: ulid(),
      profileId: currentProfile.id,
      previousVersionId: currentVersion.id,
      createdAt: at,
      updatedAt: at,
      draft: {
        trim: currentVersion.trim,
        bleedMm: currentVersion.bleedMm,
        safeContentRegion: currentVersion.safeContentRegion,
        dpiMin: currentVersion.dpiMin,
        color: {
          mode: "cmyk",
          iccAssetId: imported.asset.id,
          iccChecksum: imported.asset.sha256,
        },
        cropMarks: currentVersion.cropMarks,
        spine: currentVersion.spine,
        coverTemplate: currentVersion.coverTemplate,
        requiredBlankPages: currentVersion.requiredBlankPages,
      },
    });
    harness.print.profileVersions.insert(forgedVersion);
    const forgedProfile = harness.print.profiles.update(
      currentProfile.revision,
      {
        ...currentProfile,
        revision: currentProfile.revision + 1,
        updatedAt: at,
        currentVersionId: forgedVersion.id,
      },
    );
    const project = harness.fixture.authoring.projects.get(
      harness.fixture.projectId,
    )!;

    await expect(
      harness.production.start({
        owner: harness.fixture.owner,
        projectId: project.id,
        expectedProjectRevision: project.revision,
        profileId: forgedProfile.id,
        expectedProfileRevision: forgedProfile.revision,
        profileVersionId: forgedVersion.id,
        contentAuthorizationHash: harness.authorizationHash,
        idempotencyKey: "rgb-icc-persisted-cmyk-profile",
      }),
    ).rejects.toThrow("PRINT_RUN_STALE");
    expectZeroPrintWork(harness);
    harness.store.close();
  });
});

function setup() {
  return setupMaterializationHarness(cleanups);
}
