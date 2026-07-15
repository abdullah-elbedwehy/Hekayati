import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { LayoutRepositories } from "../../src/domain/layout/repositories.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-15T00:00:00.000Z";
const ids = Array.from(
  { length: 12 },
  (_, index) => `01J${String(index + 1).padStart(23, "0")}`,
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("layout repositories", () => {
  it("keeps immutable records insert-only", async () => {
    const fixture = await repositories();
    const version = layoutVersion();

    expect(fixture.repositories.layoutVersions.insert(version)).toEqual(
      version,
    );
    expect(() =>
      fixture.repositories.layoutVersions.insert({
        ...version,
        layoutHash: "9".repeat(64),
      }),
    ).toThrow("LAYOUT_DUPLICATE_ENTITY");
    expect(fixture.repositories.layoutVersions.get(version.id)).toEqual(
      version,
    );
    fixture.store.close();
  });

  it("advances a mutable head only through exact revision CAS", async () => {
    const fixture = await repositories();
    const head = {
      id: ids[0],
      schemaVersion: 1 as const,
      createdAt: at,
      updatedAt: at,
      revision: 0,
      pageId: ids[0],
      currentLayoutVersionId: ids[1],
    };
    fixture.repositories.pageLayoutHeads.insert(head);
    const advanced = fixture.repositories.pageLayoutHeads.update(0, {
      ...head,
      revision: 1,
      updatedAt: "2026-07-15T00:01:00.000Z",
      currentLayoutVersionId: ids[2],
    });
    expect(advanced.currentLayoutVersionId).toBe(ids[2]);

    expect(() =>
      fixture.repositories.pageLayoutHeads.update(0, {
        ...head,
        revision: 1,
        currentLayoutVersionId: ids[3],
      }),
    ).toThrow("LAYOUT_REVISION_CONFLICT");
    expect(() =>
      fixture.repositories.pageLayoutHeads.update(1, {
        ...advanced,
        pageId: ids[4],
        revision: 2,
      }),
    ).toThrow("PAGE_LAYOUT_HEAD_ID_MISMATCH");
    expect(() =>
      fixture.repositories.pageLayoutHeads.update(0, {
        ...head,
        id: ids[5],
        pageId: ids[5],
        revision: 1,
      }),
    ).toThrow("LAYOUT_ENTITY_NOT_FOUND");
    expect(() =>
      fixture.repositories.pageLayoutHeads.update(1, {
        ...advanced,
        revision: 3,
      }),
    ).toThrow("LAYOUT_REVISION_INVALID");
    expect(() =>
      fixture.repositories.pageLayoutHeads.update(1, {
        ...advanced,
        createdAt: "2026-07-15T00:00:01.000Z",
        revision: 2,
      }),
    ).toThrow("LAYOUT_IMMUTABLE_FIELD_CHANGED");
    expect(fixture.repositories.pageLayoutHeads.get(head.id)).toEqual(advanced);
    fixture.store.close();
  });

  it("enforces Project revision CAS while keeping ownership immutable", async () => {
    const fixture = await repositories();
    const projects = new AuthoringRepositories(fixture.store).projects;
    const project = {
      id: ids[8],
      schemaVersion: 2 as const,
      createdAt: at,
      updatedAt: at,
      customerId: ids[9],
      familyId: ids[10],
      revision: 0,
      status: "draft" as const,
      priority: 0,
      paused: false,
      currentVersionId: ids[11],
      bookVersion: 1,
      compositionProfileId: "00000000000000000000000000",
      currentCoverCompositionVersionId: null,
      currentPreviewOutputId: null,
      currentPreviewCycleId: null,
      currentContentApprovalId: null,
      printerProfileId: null,
    };
    projects.insert(project);
    const updated = projects.update({
      ...project,
      revision: 1,
      status: "generating",
    });
    expect(updated).toMatchObject({ revision: 1, status: "generating" });
    expect(() =>
      projects.update({ ...project, revision: 1, status: "archived" }),
    ).toThrow("PROJECT_VERSION_CONFLICT");
    expect(() =>
      projects.update({
        ...updated,
        revision: 2,
        customerId: ids[7],
      }),
    ).toThrow("PROJECT_VERSION_CONFLICT");
    fixture.store.close();
  });
});

async function repositories() {
  const temp = await temporaryDirectory("hekayati-layout-repository-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "layout.db"));
  return { store, repositories: new LayoutRepositories(store) };
}

function layoutVersion() {
  return {
    id: ids[1],
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    pageId: ids[0],
    previousVersionId: null,
    inputSnapshot: {
      compositionProfileId: "00000000000000000000000000",
      compositionProfileHash: "1".repeat(64),
      projectVersionId: ids[2],
      pageObservationRevision: 4,
      pageContentHash: "2".repeat(64),
      textVersionId: ids[3],
      illustrationVersionId: ids[4],
      templateVersion: "story-v1",
      compositionInputHash: "3".repeat(64),
      textSources: [
        {
          role: "story_text",
          entityId: ids[0],
          versionId: ids[3],
          contentHash: "4".repeat(64),
        },
      ],
      sourceAssets: [
        { role: "artwork", assetId: ids[5], checksum: "5".repeat(64) },
      ],
      typographySettingsHash: "6".repeat(64),
      fontManifestHash: "7".repeat(64),
      selectionSource: "not_applicable" as const,
      pageReviewId: ids[6],
      reviewHash: "8".repeat(64),
      compositionSourcePolicyVersion: null,
    },
    requestedPlacement: "auto" as const,
    resolvedPlacement: "top" as const,
    resolvedRegion: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
    readabilityAid: "none" as const,
    fontSizePt: 20,
    overflow: false,
    warnings: [],
    acceptance: "ready" as const,
    bubbles: [],
    measurementHash: "a".repeat(64),
    layoutPolicyVersion: "hekayati.layout.v1",
    rendererVersion: "hekayati.chromium.v1",
    workRequestId: null,
    jobId: ids[7],
    layoutHash: "b".repeat(64),
  };
}
