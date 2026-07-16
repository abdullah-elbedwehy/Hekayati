import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import type { ApprovedBookSnapshot } from "../../src/domain/layout/approvals.js";
import type { PreviewOutput } from "../../src/domain/layout/schemas.js";
import { PrintProductionService } from "../../src/domain/print/workflow.js";
import type { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  expectZeroPrintWork,
  fixedApprovedSnapshot as fixedSnapshot,
  materializationStartInput as startInput,
  type MaterializationHarness,
  type MaterializationStartInput,
  setupMaterializationHarness,
} from "../helpers/print-materialization-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("print materialization authorization fence", () => {
  it.each(snapshotMismatchCases)(
    "creates zero work for $name snapshot mismatch",
    async ({ mutate }) => {
      const harness = await setup();
      const input = await startInput(harness, `snapshot-${ulid()}`);
      const snapshot = await harness.reader.read(harness.fixture.projectId);
      const production = new PrintProductionService(
        harness.store,
        harness.assets,
        harness.scheduler,
        fixedSnapshot(mutate(structuredClone(snapshot))),
      );

      await expect(production.start(input)).rejects.toThrow();
      expectZeroPrintWork(harness);
      harness.store.close();
    },
  );

  it.each(startInputMismatchCases)(
    "creates zero work for $name start mismatch",
    async ({ mutate }) => {
      const harness = await setup();
      const valid = await startInput(harness, `input-${ulid()}`);

      await expect(harness.production.start(mutate(valid))).rejects.toThrow();
      expectZeroPrintWork(harness);
      harness.store.close();
    },
  );

  it.each(persistedMismatchCases)(
    "creates zero work when persisted $name changes after snapshot read",
    async ({ mutate }) => {
      const harness = await setup();
      const input = await startInput(harness, `persisted-${ulid()}`);
      const snapshot = await harness.reader.read(harness.fixture.projectId);
      await mutate(harness);
      const production = new PrintProductionService(
        harness.store,
        harness.assets,
        harness.scheduler,
        fixedSnapshot(snapshot),
      );

      await expect(production.start(input)).rejects.toThrow();
      expectZeroPrintWork(harness);
      harness.store.close();
    },
  );
});

interface SnapshotMismatchCase {
  name: string;
  mutate: (snapshot: ApprovedBookSnapshot) => ApprovedBookSnapshot;
}

const otherId = () => ulid();
const otherHash = () => "f".repeat(64);

const snapshotMismatchCases: SnapshotMismatchCase[] = [
  snapshotCase("project binding", (snapshot) => {
    snapshot.projectId = otherId();
  }),
  snapshotCase("project version", (snapshot) => {
    snapshot.projectVersionId = otherId();
  }),
  snapshotCase("composition profile", (snapshot) => {
    snapshot.compositionProfileId = otherId();
  }),
  snapshotCase("cover composition", (snapshot) => {
    snapshot.coverCompositionVersionId = otherId();
  }),
  snapshotCase("approval cycle", (snapshot) => {
    snapshot.approvalCycleId = otherId();
  }),
  snapshotCase("approval gate", (snapshot) => {
    snapshot.approvalGateJobId = otherId();
  }),
  snapshotCase("preview output", (snapshot) => {
    snapshot.previewOutputId = otherId();
  }),
  snapshotCase("customer content hash", (snapshot) => {
    snapshot.customerContentHash = otherHash();
  }),
  snapshotCase("authorization hash", (snapshot) => {
    snapshot.contentAuthorizationHash = otherHash();
  }),
  snapshotCase("page identity and order", (snapshot) => {
    snapshot.orderedInteriorPages[0].pageId = otherId();
  }),
  snapshotCase("layout version and hash", (snapshot) => {
    snapshot.orderedInteriorPages[0].layoutVersionId = otherId();
    snapshot.orderedInteriorPages[0].layoutHash = otherHash();
  }),
  snapshotCase("review version and hash", (snapshot) => {
    snapshot.orderedInteriorPages[0].pageReviewId = otherId();
    snapshot.orderedInteriorPages[0].reviewHash = otherHash();
  }),
  snapshotCase("text version and source hash", (snapshot) => {
    snapshot.orderedInteriorPages[0].textVersionId = otherId();
    snapshot.orderedInteriorPages[0].textSources[0].contentHash = otherHash();
  }),
  snapshotCase("composition input hash", (snapshot) => {
    snapshot.orderedInteriorPages[0].compositionInputHash = otherHash();
  }),
  snapshotCase("illustration version", (snapshot) => {
    snapshot.orderedInteriorPages[0].illustrationVersionId = otherId();
  }),
  snapshotCase("interior source checksum", (snapshot) => {
    snapshot.orderedInteriorPages[0].sourceAssets[0].checksum = otherHash();
  }),
  snapshotCase("cover source checksum", (snapshot) => {
    snapshot.coverSourceAssets[0].checksum = otherHash();
  }),
];

const startInputMismatchCases: Array<{
  name: string;
  mutate: (input: MaterializationStartInput) => MaterializationStartInput;
}> = [
  inputCase("project owner", (input) => {
    input.owner = { ...input.owner, customerId: otherId() };
  }),
  inputCase("project revision", (input) => {
    input.expectedProjectRevision += 1;
  }),
  inputCase("profile identity", (input) => {
    input.profileId = otherId();
  }),
  inputCase("profile revision", (input) => {
    input.expectedProfileRevision += 1;
  }),
  inputCase("profile version", (input) => {
    input.profileVersionId = otherId();
  }),
  inputCase("requested authorization hash", (input) => {
    input.contentAuthorizationHash = otherHash();
  }),
];

const persistedMismatchCases: Array<{
  name: string;
  mutate: (harness: MaterializationHarness) => Promise<void> | void;
}> = [
  {
    name: "approval state",
    mutate: (harness) => {
      const cycle = harness.fixture.layout.bookApprovalCycles.get(
        harness.bundle.cycle.id,
      )!;
      harness.fixture.layout.bookApprovalCycles.update(cycle.revision, {
        ...cycle,
        revision: cycle.revision + 1,
        updatedAt: new Date().toISOString(),
        state: "invalidated",
        invalidatedBy: {
          eventId: ulid(),
          matrixRow: "IM-11",
          at: new Date().toISOString(),
        },
      });
    },
  },
  {
    name: "preview output state",
    mutate: (harness) => {
      const output = harness.fixture.layout.previewOutputs.get(
        harness.bundle.output.id,
      )!;
      harness.fixture.layout.previewOutputs.update(output.revision, {
        ...output,
        revision: output.revision + 1,
        updatedAt: new Date().toISOString(),
        status: "stale",
        staleReasons: ["IM-11"],
        invalidatedByEventIds: [ulid()],
      });
    },
  },
  {
    name: "approval gate state",
    mutate: (harness) => {
      const gate = harness.scheduler.get(harness.bundle.gateId)!;
      overwriteDocument(harness.store, "jobs", gate.id, {
        ...gate,
        revision: gate.revision + 1,
        updatedAt: new Date().toISOString(),
        state: "canceled",
        stateReason: "injected_gate_drift",
      });
    },
  },
  {
    name: "project version and revision",
    mutate: (harness) => {
      const project = harness.fixture.authoring.projects.get(
        harness.fixture.projectId,
      )!;
      harness.fixture.authoring.projects.update({
        ...project,
        revision: project.revision + 1,
        updatedAt: new Date().toISOString(),
        currentVersionId: ulid(),
      });
    },
  },
  {
    name: "profile head and revision",
    mutate: (harness) => {
      harness.print.profiles.update(harness.profile.profile.revision, {
        ...harness.profile.profile,
        revision: harness.profile.profile.revision + 1,
        updatedAt: new Date().toISOString(),
        currentVersionId: ulid(),
      });
    },
  },
  {
    name: "profile version hash",
    mutate: (harness) => {
      overwriteDocument(
        harness.store,
        "printer_profile_versions",
        harness.profile.version.id,
        { ...harness.profile.version, profileHash: otherHash() },
      );
    },
  },
  persistedOutputCase("output customer hash", (output) => {
    output.customerContentHash = otherHash();
  }),
  persistedOutputCase("page content hash", (output) => {
    output.orderedInteriorPages[0].pageContentHash = otherHash();
  }),
  persistedOutputCase("layout version and hash", (output) => {
    output.orderedInteriorPages[0].layoutVersionId = ulid();
    output.orderedInteriorPages[0].layoutHash = otherHash();
  }),
  persistedOutputCase("review version and hash", (output) => {
    output.orderedInteriorPages[0].pageReviewId = ulid();
    output.orderedInteriorPages[0].reviewHash = otherHash();
  }),
  persistedOutputCase("text version and source hash", (output) => {
    output.orderedInteriorPages[0].textVersionId = ulid();
    output.orderedInteriorPages[0].textSources[0].contentHash = otherHash();
  }),
  persistedOutputCase("source checksum", (output) => {
    output.orderedInteriorPages[0].sourceAssets[0].checksum = otherHash();
  }),
  {
    name: "cover source checksum",
    mutate: (harness) => {
      overwriteDocument(
        harness.store,
        "cover_composition_versions",
        harness.fixture.coverVersion.id,
        {
          ...harness.fixture.coverVersion,
          sourceAssets: harness.fixture.coverVersion.sourceAssets.map(
            (source, index) =>
              index === 0 ? { ...source, checksum: otherHash() } : source,
          ),
        },
      );
    },
  },
];

function snapshotCase(
  name: string,
  change: (snapshot: ApprovedBookSnapshot) => void,
): SnapshotMismatchCase {
  return {
    name,
    mutate: (snapshot) => {
      change(snapshot);
      return snapshot;
    },
  };
}

function inputCase(
  name: string,
  change: (input: MaterializationStartInput) => void,
): {
  name: string;
  mutate: (input: MaterializationStartInput) => MaterializationStartInput;
} {
  return {
    name,
    mutate: (input) => {
      const changed = structuredClone(input);
      change(changed);
      return changed;
    },
  };
}

function persistedOutputCase(
  name: string,
  change: (output: PreviewOutput) => void,
): {
  name: string;
  mutate: (harness: MaterializationHarness) => void;
} {
  return {
    name,
    mutate: (harness) => {
      const output = harness.fixture.layout.previewOutputs.get(
        harness.bundle.output.id,
      )!;
      const changed = structuredClone(output);
      change(changed);
      overwriteDocument(harness.store, "preview_outputs", changed.id, changed);
    },
  };
}

function overwriteDocument<T extends { updatedAt: string }>(
  store: DocumentStore,
  collection: string,
  id: string,
  document: T,
): void {
  store.database
    .prepare(
      `UPDATE documents SET doc = ?, updated_at = ?
       WHERE collection = ? AND id = ?`,
    )
    .run(JSON.stringify(document), document.updatedAt, collection, id);
}

function setup() {
  return setupMaterializationHarness(cleanups);
}
