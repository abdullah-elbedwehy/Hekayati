import { afterEach, describe, expect, it } from "vitest";

import { DocumentRepository } from "../../src/domain/repository/document-store.js";
import {
  createPortabilityFixture,
  syntheticStudioFixtureSchema,
  type PortabilityFixture,
} from "../helpers/portability-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("portability full-graph fixture", () => {
  it("persists an owned delivery graph, unrelated scope, and real media", async () => {
    const fixture = await trackedFixture();
    const requiredCollections = [
      "assets",
      "book_approval_actions",
      "book_approval_cycles",
      "character_approvals",
      "character_sheet_intents",
      "character_sheets",
      "character_versions",
      "characters",
      "composition_profiles",
      "converted_proof_actions",
      "cover_composition_versions",
      "cover_compositions",
      "creative_runs",
      "creative_stage_records",
      "customers",
      "families",
      "finding_acknowledgements",
      "illustration_versions",
      "invalidation_audits",
      "job_events",
      "jobs",
      "layout_versions",
      "layout_work_requests",
      "original_assets",
      "page_layout_heads",
      "page_prompt_versions",
      "page_reviews",
      "page_text_versions",
      "pages",
      "preview_outputs",
      "preview_workflows",
      "print_artifacts",
      "print_preflight_reports",
      "print_proof_bundles",
      "print_runs",
      "printer_profile_versions",
      "printer_profiles",
      "project_versions",
      "projects",
      "reference_photos",
      "scene_versions",
      "scenes",
      "stories",
      "story_versions",
      "synthetic_studio_entries",
    ];

    for (const collection of requiredCollections)
      expect(fixture.idsByCollection[collection], collection).not.toHaveLength(
        0,
      );
    expect(Object.isFrozen(fixture.idsByCollection)).toBe(true);
    expect(fixture.scope).not.toEqual(fixture.unrelatedScope);
    expect(fixture.idsByCollection.projects).toContain(fixture.scope.projectId);
    expect(fixture.idsByCollection.projects).toContain(
      fixture.unrelatedScope.projectId,
    );

    expect(
      await fixture.originals.read(fixture.records.originalAssetId),
    ).toEqual(Buffer.from("synthetic-portability-original"));
    for (const assetId of [
      fixture.records.workingAssetId,
      fixture.records.thumbnailAssetId,
      fixture.records.providerAssetId,
      fixture.records.repeatedAssetId,
    ])
      expect((await fixture.assets.read(assetId)).byteLength).toBeGreaterThan(
        0,
      );

    expect(fixture.assets.get(fixture.records.repeatedAssetId)?.refCount).toBe(
      1,
    );
    expect(repeatedReferenceCount(fixture)).toBeGreaterThan(10);
    expect(
      fixture.assets.get(fixture.records.retainedReuseAssetId)?.refCount,
    ).toBe(2);

    const studio = new DocumentRepository(
      fixture.store,
      "synthetic_studio_entries",
      syntheticStudioFixtureSchema,
    ).list();
    expect(studio).toHaveLength(2);
    expect(studio.map((entry) => entry.owner.kind).sort()).toEqual([
      "customer",
      "prompt_only",
    ]);
    expect(
      studio.every(
        (entry) => entry.assetId === fixture.records.retainedReuseAssetId,
      ),
    ).toBe(true);
  });
});

async function trackedFixture(): Promise<PortabilityFixture> {
  const fixture = await createPortabilityFixture();
  cleanups.push(fixture.cleanup);
  return fixture;
}

function repeatedReferenceCount(fixture: PortabilityFixture): number {
  const rows = fixture.store.database
    .prepare("SELECT doc FROM documents WHERE doc LIKE ?")
    .all(`%${fixture.records.repeatedAssetId}%`) as Array<{ doc: string }>;
  return rows.reduce(
    (count, row) =>
      count + row.doc.split(fixture.records.repeatedAssetId).length - 1,
    0,
  );
}
