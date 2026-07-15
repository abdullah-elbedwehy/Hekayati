import type { AssetRecord } from "../../assets/asset-store.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { Project, ProjectVersion } from "../authoring/schemas.js";
import { CreativeRepositories } from "../creative/repositories.js";
import type {
  CharacterSheet,
  IllustrationVersion,
  Page,
} from "../creative/schemas.js";
import { LibraryRepositories } from "../library/repositories.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failLayout } from "./errors.js";
import { hashCanonical } from "./hashes.js";

export interface CompositionSourceAsset {
  assetId: string;
  checksum: string;
}

export interface ResolvedCompositionSources {
  project: Project;
  projectVersion: ProjectVersion;
  childDisplayName: string;
  hero: CompositionSourceAsset | null;
  heroSelection: "story_illustration" | "character_sheet" | null;
}

export interface CompositionAssetCatalog {
  get(assetId: string): Pick<AssetRecord, "id" | "sha256"> | null;
}

export function resolveCompositionSources(
  store: DocumentStore,
  assets: CompositionAssetCatalog,
  projectId: string,
): ResolvedCompositionSources {
  const authoring = new AuthoringRepositories(store);
  const creative = new CreativeRepositories(store);
  const library = new LibraryRepositories(store);
  const project = authoring.projects.get(projectId);
  const projectVersion = project
    ? authoring.projectVersions.get(project.currentVersionId)
    : null;
  if (!project || !projectVersion) failLayout("LAYOUT_SOURCE_NOT_FOUND", 404);
  const mainChild = projectVersion.storyConfig.participants.find(
    (participant) =>
      participant.characterId === projectVersion.storyConfig.mainChildId,
  );
  const childVersion = mainChild
    ? library.characterVersions.get(mainChild.characterVersionId)
    : null;
  if (!mainChild || !childVersion) failLayout("LAYOUT_SOURCE_NOT_FOUND", 404);

  const storyHero = firstReviewedStoryAsset(creative, assets, project.id);
  if (storyHero)
    return {
      project,
      projectVersion,
      childDisplayName: childVersion.profile.name,
      hero: storyHero,
      heroSelection: "story_illustration",
    };
  const sheetHero = approvedSheetAsset(
    creative,
    assets,
    project.id,
    mainChild.characterId,
    mainChild.characterVersionId,
  );
  return {
    project,
    projectVersion,
    childDisplayName: childVersion.profile.name,
    hero: sheetHero,
    heroSelection: sheetHero ? "character_sheet" : null,
  };
}

export function compositionSourcesHash(
  value: ResolvedCompositionSources,
): string {
  return hashCanonical({
    projectId: value.project.id,
    projectVersionId: value.projectVersion.id,
    childDisplayName: value.childDisplayName,
    hero: value.hero,
    heroSelection: value.heroSelection,
  });
}

export function eligibleCompositionAssets(
  store: DocumentStore,
  assets: CompositionAssetCatalog,
  projectId: string,
): CompositionSourceAsset[] {
  const creative = new CreativeRepositories(store);
  const candidates: CompositionSourceAsset[] = [];
  for (const page of creative.pages
    .queryByField("projectId", projectId)
    .sort((left, right) => left.pageNumber - right.pageNumber)) {
    const illustration = exactReviewedIllustration(creative, page);
    const asset = illustration ? assets.get(illustration.assetId) : null;
    if (asset) candidates.push({ assetId: asset.id, checksum: asset.sha256 });
  }
  for (const sheet of creative.sheets
    .queryByField("projectId", projectId)
    .filter((candidate) => candidate.status === "approved")
    .sort(compareSheets)) {
    const asset = assets.get(sheet.views.threeQuarter);
    if (asset) candidates.push({ assetId: asset.id, checksum: asset.sha256 });
  }
  return [
    ...new Map(candidates.map((asset) => [asset.assetId, asset])).values(),
  ];
}

export function requireEligibleCompositionAsset(
  store: DocumentStore,
  assets: CompositionAssetCatalog,
  projectId: string,
  assetId: string,
): CompositionSourceAsset {
  const selected = eligibleCompositionAssets(store, assets, projectId).find(
    (candidate) => candidate.assetId === assetId,
  );
  if (!selected) failLayout("LAYOUT_SOURCE_NOT_FOUND", 404);
  return selected;
}

function firstReviewedStoryAsset(
  creative: CreativeRepositories,
  assets: CompositionAssetCatalog,
  projectId: string,
): CompositionSourceAsset | null {
  const pages = creative.pages
    .queryByField("projectId", projectId)
    .filter((page) => page.kind === "story")
    .sort((left, right) => left.pageNumber - right.pageNumber);
  for (const page of pages) {
    const illustration = exactReviewedIllustration(creative, page);
    if (!illustration) continue;
    const asset = assets.get(illustration.assetId);
    if (asset) return { assetId: asset.id, checksum: asset.sha256 };
  }
  return null;
}

function exactReviewedIllustration(
  creative: CreativeRepositories,
  page: Page,
): IllustrationVersion | null {
  if (
    page.reviewStatus !== "approved" ||
    page.staleState !== "current" ||
    !page.currentTextVersionId ||
    !page.currentIllustrationVersionId
  )
    return null;
  const reviewed = creative.reviews
    .queryByField("pageId", page.id)
    .some(
      (review) =>
        review.completed &&
        review.textVersionId === page.currentTextVersionId &&
        review.illustrationVersionId === page.currentIllustrationVersionId,
    );
  return reviewed
    ? creative.illustrations.get(page.currentIllustrationVersionId)
    : null;
}

function approvedSheetAsset(
  creative: CreativeRepositories,
  assets: CompositionAssetCatalog,
  projectId: string,
  characterId: string,
  characterVersionId: string,
): CompositionSourceAsset | null {
  const sheet = creative.sheets
    .queryByField("projectId", projectId)
    .filter(
      (candidate) =>
        candidate.characterId === characterId &&
        candidate.characterVersionId === characterVersionId &&
        candidate.status === "approved",
    )
    .sort(compareSheets)
    .at(-1);
  if (!sheet) return null;
  const asset = assets.get(sheet.views.threeQuarter);
  return asset ? { assetId: asset.id, checksum: asset.sha256 } : null;
}

function compareSheets(left: CharacterSheet, right: CharacterSheet): number {
  const byTime = left.updatedAt.localeCompare(right.updatedAt);
  return byTime || left.id.localeCompare(right.id);
}
