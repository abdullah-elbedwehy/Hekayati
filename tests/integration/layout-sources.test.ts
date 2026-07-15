import { afterEach, describe, expect, it } from "vitest";

import { resolveDataPaths } from "../../src/config/paths.js";
import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import type { Project } from "../../src/domain/authoring/schemas.js";
import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import {
  compositionSourcesHash,
  eligibleCompositionAssets,
  requireEligibleCompositionAsset,
  resolveCompositionSources,
  type CompositionAssetCatalog,
} from "../../src/domain/layout/sources.js";
import { seedCreativeProject } from "../helpers/creative-fixtures.js";
import { createLayoutWorkflowFixture } from "../helpers/layout-workflow-fixture.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
const at = "2026-07-15T06:00:00.000Z";
const fixedId = (value: number) => `01J${String(value).padStart(23, "0")}`;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("composition source resolver", () => {
  it("selects the first exact reviewed story asset, deduplicates eligibility, and ignores stale pages", async () => {
    const temp = await temporaryDirectory("hekayati-layout-sources-story-");
    cleanups.push(temp.cleanup);
    const fixture = await createLayoutWorkflowFixture(temp.path);
    const resolved = resolveCompositionSources(
      fixture.store,
      fixture.assets,
      fixture.seed.projectId,
    );
    const eligible = eligibleCompositionAssets(
      fixture.store,
      fixture.assets,
      fixture.seed.projectId,
    );
    expect(resolved).toMatchObject({
      heroSelection: "story_illustration",
      hero: eligible[0],
    });
    expect(eligible).toHaveLength(1);
    expect(compositionSourcesHash(resolved)).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      requireEligibleCompositionAsset(
        fixture.store,
        fixture.assets,
        fixture.seed.projectId,
        eligible[0].assetId,
      ),
    ).toEqual(eligible[0]);
    expect(() =>
      requireEligibleCompositionAsset(
        fixture.store,
        fixture.assets,
        fixture.seed.projectId,
        fixedId(999),
      ),
    ).toThrow("LAYOUT_SOURCE_NOT_FOUND");

    const creative = new CreativeRepositories(fixture.store);
    for (const page of creative.pages
      .queryByField("projectId", fixture.seed.projectId)
      .filter((candidate) => candidate.kind === "story"))
      creative.pages.update({
        ...page,
        revision: page.revision + 1,
        updatedAt: at,
        staleState: "stale",
        staleReasons: ["IM-06"],
      });
    expect(
      resolveCompositionSources(
        fixture.store,
        fixture.assets,
        fixture.seed.projectId,
      ),
    ).toMatchObject({ hero: null, heroSelection: null });
    fixture.store.close();
  });

  it("uses the latest approved exact-character sheet fallback and requires its indexed asset", async () => {
    const temp = await temporaryDirectory("hekayati-layout-sources-sheet-");
    cleanups.push(temp.cleanup);
    const seed = await seedCreativeProject(temp.path, "-sources");
    const store = new DocumentStore(resolveDataPaths(temp.path).database);
    const project = new AuthoringRepositories(store).projects.get(
      seed.projectId,
    )!;
    const version = new AuthoringRepositories(store).projectVersions.get(
      project.currentVersionId,
    )!;
    const participant = version.storyConfig.participants[0];
    const assets = catalog([
      [fixedId(70), "7".repeat(64)],
      [fixedId(71), "8".repeat(64)],
    ]);
    const creative = new CreativeRepositories(store);
    creative.sheets.insert(
      sheet(
        project,
        participant.characterId,
        participant.characterVersionId,
        90,
        70,
      ),
    );
    creative.sheets.insert(
      sheet(
        project,
        participant.characterId,
        participant.characterVersionId,
        91,
        71,
      ),
    );

    expect(resolveCompositionSources(store, assets, project.id)).toMatchObject({
      childDisplayName: `نور-sources`,
      heroSelection: "character_sheet",
      hero: { assetId: fixedId(71), checksum: "8".repeat(64) },
    });
    expect(eligibleCompositionAssets(store, assets, project.id)).toEqual([
      { assetId: fixedId(70), checksum: "7".repeat(64) },
      { assetId: fixedId(71), checksum: "8".repeat(64) },
    ]);
    expect(
      resolveCompositionSources(store, catalog([]), project.id),
    ).toMatchObject({ hero: null, heroSelection: null });
    expect(() =>
      resolveCompositionSources(store, assets, fixedId(998)),
    ).toThrow("LAYOUT_SOURCE_NOT_FOUND");
    store.close();
  });
});

function catalog(entries: Array<[string, string]>): CompositionAssetCatalog {
  const records = new Map(
    entries.map(([id, sha256]) => [id, { id, sha256 }] as const),
  );
  return { get: (assetId) => records.get(assetId) ?? null };
}

function sheet(
  project: Project,
  characterId: string,
  characterVersionId: string,
  sheetNumber: number,
  assetNumber: number,
) {
  return {
    id: fixedId(sheetNumber),
    schemaVersion: 1 as const,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    projectId: project.id,
    customerId: project.customerId,
    familyId: project.familyId,
    characterId,
    characterVersionId,
    appearance: { type: "base" as const, lookId: null, lookVersionId: null },
    characterName: "نور",
    views: {
      face: fixedId(sheetNumber + 100),
      front: fixedId(sheetNumber + 200),
      threeQuarter: fixedId(assetNumber),
      fullBody: fixedId(sheetNumber + 300),
      mainOutfit: fixedId(sheetNumber + 400),
    },
    referenceThumbnailAssetIds: [],
    referenceLineage: {
      source: "description_only" as const,
      referencePhotoIds: [],
    },
    pdfAssetId: fixedId(sheetNumber + 500),
    status: "approved" as const,
    priorSheetId: null,
    generationJobIds: Array.from({ length: 6 }, (_, index) =>
      fixedId(sheetNumber + 600 + index),
    ),
    provenanceByView: {},
  };
}
