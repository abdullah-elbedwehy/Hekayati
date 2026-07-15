import type { AssetRecord } from "../../assets/asset-store.js";
import type { Project, ProjectVersion } from "../authoring/schemas.js";
import type { CreativeRepositories } from "../creative/repositories.js";
import type { Page } from "../creative/schemas.js";
import { COMPOSITION_SOURCE_POLICY_VERSION } from "./composition.js";
import { failLayout } from "./errors.js";
import { hashCanonical } from "./hashes.js";
import { A4_COMPOSITION_PROFILE, A4_COMPOSITION_PROFILE_ID } from "./policy.js";
import type {
  CompositionProfile,
  CoverCompositionVersion,
  LayoutVersion,
  PreviewWorkflow,
} from "./schemas.js";
import {
  compositionSourcesHash,
  type CompositionAssetCatalog,
  type CompositionSourceAsset,
  type ResolvedCompositionSources,
} from "./sources.js";

export const LAYOUT_FONT_MANIFEST_HASH = hashCanonical({
  version: "hekayati.preview-fonts.v1",
  families: ["IBMPlexSansArabic", "Lemonada"],
});

export const COVER_BRAND_TEMPLATE_HASH = hashCanonical(
  "hekayati.citrus-cover.v1",
);

export interface ChangeSpecialCompositionSourceInput {
  pageId: string;
  expectedPageRevision: number;
  expectedWorkflowRevision: number;
  assetId: string | null;
  requestedPlacement: "auto" | "top" | "bottom" | "right" | "left";
}

export interface RegeneratePreviewInput {
  expectedProjectRevision: number;
  expectedWorkflowRevision: number;
}

export interface ChangeCoverCompositionInput {
  expectedProjectRevision: number;
  expectedWorkflowRevision: number;
  expectedCoverVersionId: string;
  frontArtworkAssetId: string;
  backArtworkAssetId?: string | null;
  environmentLine?: string | null;
  synopsis?: string | null;
}

export interface LayoutJobSource {
  projectId: string;
  page: Page;
  workflowHash: string;
  sourceAssetId: string | null;
  selectedAsset: CompositionSourceAsset | null;
  selectionSource: "automatic_v1" | "operator";
  requestedPlacement: "auto" | "top" | "bottom" | "right" | "left";
  workRequestId: string | null;
  typographySettingsHash: string;
  fontManifestHash: string;
}

export interface PreviewJobSnapshot {
  project: Project;
  projectVersion: ProjectVersion;
  workflow: PreviewWorkflow;
  profile: CompositionProfile;
  cover: CoverCompositionVersion;
  pages: Array<{ page: Page; layout: LayoutVersion }>;
  watermarkText: string;
  watermarkSettingsHash: string;
}

export interface WorkflowSnapshot {
  project: Project;
  pages: Page[];
  inputHash: string;
  typographySettingsHash: string;
  sources: ResolvedCompositionSources;
}

export interface LayoutReadiness {
  ready: boolean;
  needsJobs: Page[];
  blockingReasons: string[];
}

export function pageInputBlock(
  page: Page,
  creative: CreativeRepositories,
  assets: CompositionAssetCatalog,
): string | null {
  if (page.staleState !== "current") return "LAYOUT_PAGE_STALE";
  if (page.kind !== "story") return null;
  if (!page.locked) return "LAYOUT_PAGE_UNLOCKED";
  if (
    page.reviewStatus !== "approved" ||
    !page.currentTextVersionId ||
    !page.currentIllustrationVersionId ||
    !exactReviewId(creative, page)
  )
    return "LAYOUT_REVIEW_REQUIRED";
  const illustration = creative.illustrations.get(
    page.currentIllustrationVersionId,
  );
  if (!illustration || !assets.get(illustration.assetId))
    return "LAYOUT_SOURCE_REQUIRED";
  return null;
}

export function workflowInputHash(
  sources: ResolvedCompositionSources,
  pages: readonly Page[],
  creative: CreativeRepositories,
  assets: CompositionAssetCatalog,
  typographySettingsHash: string,
): string {
  return hashCanonical({
    projectVersionId: sources.projectVersion.id,
    compositionProfileId: sources.project.compositionProfileId,
    sourceHash: compositionSourcesHash(sources),
    typographySettingsHash,
    fontManifestHash: LAYOUT_FONT_MANIFEST_HASH,
    pages: pages.map((page) => pageSnapshot(page, creative, assets)),
  });
}

export function pageSnapshot(
  page: Page,
  creative: CreativeRepositories,
  assets: CompositionAssetCatalog,
) {
  const text = page.currentTextVersionId
    ? creative.pageTexts.get(page.currentTextVersionId)
    : null;
  const illustration = page.currentIllustrationVersionId
    ? creative.illustrations.get(page.currentIllustrationVersionId)
    : null;
  const asset = illustration ? assets.get(illustration.assetId) : null;
  const review = exactReviewId(creative, page);
  return {
    id: page.id,
    kind: page.kind,
    pageNumber: page.pageNumber,
    staleState: page.staleState,
    textVersionId: text?.id ?? null,
    illustrationVersionId: illustration?.id ?? null,
    assetChecksum: asset?.sha256 ?? null,
    reviewId: review,
  };
}

export function currentLayoutMatches(
  page: Page,
  version: LayoutVersion | null,
  snapshot: WorkflowSnapshot,
  creative: CreativeRepositories,
  assets: CompositionAssetCatalog,
): boolean {
  if (
    latestPendingLayoutRequest(creative, page.id) ||
    !version ||
    version.pageId !== page.id ||
    version.acceptance !== "ready" ||
    version.inputSnapshot.projectVersionId !==
      snapshot.sources.projectVersion.id ||
    version.inputSnapshot.compositionProfileId !== A4_COMPOSITION_PROFILE_ID ||
    version.inputSnapshot.typographySettingsHash !==
      snapshot.typographySettingsHash ||
    version.inputSnapshot.fontManifestHash !== LAYOUT_FONT_MANIFEST_HASH ||
    page.staleState !== "current"
  )
    return false;
  if (page.kind !== "story")
    return currentSpecialLayoutMatches(page, version, snapshot, assets);
  const illustration = page.currentIllustrationVersionId
    ? creative.illustrations.get(page.currentIllustrationVersionId)
    : null;
  const asset = illustration ? assets.get(illustration.assetId) : null;
  return (
    page.reviewStatus === "approved" &&
    page.currentTextVersionId === version.inputSnapshot.textVersionId &&
    page.currentIllustrationVersionId ===
      version.inputSnapshot.illustrationVersionId &&
    exactReviewId(creative, page) === version.inputSnapshot.pageReviewId &&
    asset?.sha256 === version.inputSnapshot.sourceAssets[0]?.checksum
  );
}

export function hasPendingLayoutRequest(
  pages: readonly Page[],
  creative: CreativeRepositories,
): boolean {
  return pages.some((page) => latestPendingLayoutRequest(creative, page.id));
}

export function latestPendingLayoutRequest(
  creative: CreativeRepositories,
  pageId: string,
) {
  return creative.layoutWorkRequests
    .queryByField("pageId", pageId)
    .filter((request) => request.state === "pending")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
}

export function currentSpecialLayoutMatches(
  page: Page,
  version: LayoutVersion,
  snapshot: WorkflowSnapshot,
  assets: CompositionAssetCatalog,
): boolean {
  if (
    version.inputSnapshot.pageReviewId !== null ||
    version.inputSnapshot.compositionSourcePolicyVersion !==
      COMPOSITION_SOURCE_POLICY_VERSION
  )
    return false;
  const expected = compositionAssetForPage(page, snapshot.sources);
  const source = version.inputSnapshot.sourceAssets[0];
  if (version.inputSnapshot.selectionSource === "operator") {
    if (page.kind === "dedication" && !source) return true;
    return Boolean(
      source && assets.get(source.assetId)?.sha256 === source.checksum,
    );
  }
  if (page.kind === "dedication") return source === undefined;
  if (page.kind === "ending2")
    return Boolean(
      source && assets.get(source.assetId)?.sha256 === source.checksum,
    );
  return Boolean(
    expected &&
    source?.assetId === expected.assetId &&
    source.checksum === expected.checksum,
  );
}

export function parseRequestedPlacement(
  value: string | undefined,
): "auto" | "top" | "bottom" | "right" | "left" {
  if (
    value === "top" ||
    value === "bottom" ||
    value === "right" ||
    value === "left"
  )
    return value;
  return "auto";
}

export function exactReviewId(
  creative: CreativeRepositories,
  page: Page,
): string | null {
  if (!page.currentTextVersionId || !page.currentIllustrationVersionId)
    return null;
  return (
    creative.reviews
      .queryByField("pageId", page.id)
      .filter(
        (review) =>
          review.completed &&
          review.textVersionId === page.currentTextVersionId &&
          review.illustrationVersionId === page.currentIllustrationVersionId,
      )
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
      .at(-1)?.id ?? null
  );
}

export function compositionAssetForPage(
  page: Page,
  sources: ResolvedCompositionSources,
): CompositionSourceAsset | null {
  if (page.kind === "title" || page.kind === "ending1") return sources.hero;
  return null;
}

export function layoutJobAssetId(
  page: Page,
  sources: ResolvedCompositionSources,
  creative: CreativeRepositories,
): string | null {
  if (page.kind !== "story")
    return compositionAssetForPage(page, sources)?.assetId ?? null;
  return page.currentIllustrationVersionId
    ? (creative.illustrations.get(page.currentIllustrationVersionId)?.assetId ??
        null)
    : null;
}

export function coverMatches(
  cover: CoverCompositionVersion,
  snapshot: WorkflowSnapshot,
  assets: CompositionAssetCatalog,
): boolean {
  const hero = snapshot.sources.hero;
  if (cover.selectionSource === "operator")
    return (
      cover.projectVersionId === snapshot.sources.projectVersion.id &&
      cover.compositionProfileId === snapshot.project.compositionProfileId &&
      cover.acceptance === "ready" &&
      Boolean(cover.front.artworkAssetId) &&
      cover.sourceAssets.every(
        (source) => assets.get(source.assetId)?.sha256 === source.checksum,
      )
    );
  return (
    cover.projectVersionId === snapshot.sources.projectVersion.id &&
    cover.compositionProfileId === snapshot.project.compositionProfileId &&
    cover.front.title === snapshot.sources.projectVersion.storyConfig.title &&
    cover.front.childDisplayName === snapshot.sources.childDisplayName &&
    cover.front.artworkAssetId === hero?.assetId &&
    cover.sourceAssets[0]?.checksum === hero?.checksum &&
    cover.acceptance === "ready"
  );
}

export function operatorCoverVersion(
  snapshot: WorkflowSnapshot,
  current: CoverCompositionVersion,
  input: ChangeCoverCompositionInput,
  frontArtwork: CompositionSourceAsset,
  backArtwork: CompositionSourceAsset | null,
  at: string,
  id: string,
): CoverCompositionVersion {
  const draft = operatorCoverDraft(
    snapshot,
    current,
    input,
    frontArtwork,
    backArtwork,
    id,
  );
  return {
    ...current,
    id,
    createdAt: at,
    updatedAt: at,
    previousVersionId: current.id,
    selectionSource: "operator",
    textSources: draft.textSources,
    sourceAssets: draft.sourceAssets,
    ...draft.visible,
    warnings: [],
    acceptance: "ready",
    compositionHash: hashCanonical({
      ...draft,
      policy: COMPOSITION_SOURCE_POLICY_VERSION,
    }),
  };
}

export function operatorCoverDraft(
  snapshot: WorkflowSnapshot,
  current: CoverCompositionVersion,
  input: ChangeCoverCompositionInput,
  frontArtwork: CompositionSourceAsset,
  backArtwork: CompositionSourceAsset | null,
  id: string,
) {
  const environmentLine = normalizeOptionalCoverText(input.environmentLine);
  const synopsis = normalizeOptionalCoverText(input.synopsis);
  return {
    visible: {
      front: {
        ...current.front,
        environmentLine,
        artworkAssetId: frontArtwork.assetId,
      },
      back: {
        ...current.back,
        synopsis,
        artworkAssetId: backArtwork?.assetId ?? null,
      },
    },
    textSources: [
      ...coverTextSources(snapshot),
      ...(environmentLine
        ? [
            operatorCoverTextSource(
              "environment_line",
              snapshot,
              id,
              environmentLine,
            ),
          ]
        : []),
      ...(synopsis
        ? [operatorCoverTextSource("synopsis", snapshot, id, synopsis)]
        : []),
    ],
    sourceAssets: [
      { role: "cover_art", ...frontArtwork },
      ...(backArtwork ? [{ role: "back_cover_art", ...backArtwork }] : []),
    ],
  };
}

export function operatorCoverTextSource(
  role: string,
  snapshot: WorkflowSnapshot,
  versionId: string,
  value: string,
) {
  return {
    role,
    entityId: snapshot.project.id,
    versionId,
    contentHash: hashCanonical(value),
  };
}

export function normalizeOptionalCoverText(
  value: string | null | undefined,
): string | null {
  const normalized = value?.normalize("NFC").trim() ?? "";
  return normalized || null;
}

export function coverVersion(
  snapshot: WorkflowSnapshot,
  previous: CoverCompositionVersion | null,
  at: string,
  id: string,
): CoverCompositionVersion {
  const hero = snapshot.sources.hero;
  const sourceAssets = hero ? [{ role: "cover_art", ...hero }] : [];
  const textSources = coverTextSources(snapshot);
  const visible = coverVisible(snapshot);
  const warnings = hero
    ? []
    : [{ code: "COMPOSITION_SOURCE_REQUIRED", severity: "blocking" as const }];
  return {
    id,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    projectId: snapshot.project.id,
    compositionProfileId: snapshot.project.compositionProfileId,
    compositionProfileHash: A4_COMPOSITION_PROFILE.hash,
    previousVersionId: previous?.id ?? null,
    projectVersionId: snapshot.sources.projectVersion.id,
    compositionSourcePolicyVersion: COMPOSITION_SOURCE_POLICY_VERSION,
    selectionSource: "automatic_v1",
    textSources,
    sourceAssets,
    ...visible,
    brandTemplateHash: COVER_BRAND_TEMPLATE_HASH,
    fontManifestHash: LAYOUT_FONT_MANIFEST_HASH,
    warnings,
    acceptance: hero ? "ready" : "needs_operator",
    compositionHash: hashCanonical({
      visible,
      textSources,
      sourceAssets,
      policy: COMPOSITION_SOURCE_POLICY_VERSION,
    }),
  };
}

export function coverTextSources(snapshot: WorkflowSnapshot) {
  const config = snapshot.sources.projectVersion.storyConfig;
  return [
    coverTextSource("cover_title", snapshot, config.title),
    coverTextSource(
      "child_display_name",
      snapshot,
      snapshot.sources.childDisplayName,
    ),
    coverTextSource("brand_line", snapshot, config.endingPages.brandLine),
  ];
}

export function coverVisible(snapshot: WorkflowSnapshot) {
  const config = snapshot.sources.projectVersion.storyConfig;
  const region = { x: 0.07, y: 0.05, width: 0.86, height: 0.9 };
  return {
    front: {
      title: config.title,
      childDisplayName: snapshot.sources.childDisplayName,
      environmentLine: null,
      artworkAssetId: snapshot.sources.hero?.assetId ?? null,
      region,
    },
    back: {
      synopsis: null,
      brandLine: config.endingPages.brandLine,
      artworkAssetId: null,
      region,
    },
  };
}

export function coverTextSource(
  role: string,
  snapshot: WorkflowSnapshot,
  value: string,
) {
  return {
    role,
    entityId: snapshot.project.id,
    versionId: snapshot.sources.projectVersion.id,
    contentHash: hashCanonical(value.normalize("NFC")),
  };
}

export function projectPriority(value: number): number {
  return Math.max(1, Math.min(5, Math.ceil((value + 1) / 20)));
}

export function layoutWorkflowAsset(
  assets: CompositionAssetCatalog,
  assetId: string,
): Pick<AssetRecord, "id" | "sha256"> {
  const asset = assets.get(assetId);
  if (!asset) failLayout("LAYOUT_PREVIEW_ASSET_INVALID", 404);
  return asset;
}
