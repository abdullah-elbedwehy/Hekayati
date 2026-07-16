import type {
  CoverCompositionVersion,
  LayoutNormalizedRegion,
} from "./schemas.js";

export interface ApprovedCoverArtwork {
  assetId: string;
  checksum: string;
}

export interface ApprovedCoverTextContent {
  text: string;
  segments: ApprovedCoverTextSegment[];
  region: LayoutNormalizedRegion;
  fontSizePt: number;
  style: "heading" | "body";
  aid: "panel";
}

export interface ApprovedCoverTextSegment {
  role:
    | "title"
    | "child_display_name"
    | "environment_line"
    | "synopsis"
    | "brand_line";
  value: string;
}

export interface ApprovedCoverPanelContent {
  kind: "back" | "front";
  artwork: ApprovedCoverArtwork | null;
  text: ApprovedCoverTextContent;
}

export interface ApprovedCoverContent {
  compositionVersionId: string;
  compositionHash: string;
  brandTemplateHash: string;
  fontManifestHash: string;
  back: ApprovedCoverPanelContent;
  front: ApprovedCoverPanelContent;
}

export interface PreviewCoverTextBlock {
  heading?: string;
  body?: string;
  region: LayoutNormalizedRegion;
  fontSizePt: number;
  aid: "panel";
}

export function compileApprovedCoverContent(
  cover: CoverCompositionVersion,
): ApprovedCoverContent {
  if (cover.acceptance !== "ready") throw new Error("COVER_CONTENT_NOT_READY");
  return {
    compositionVersionId: cover.id,
    compositionHash: cover.compositionHash,
    brandTemplateHash: cover.brandTemplateHash,
    fontManifestHash: cover.fontManifestHash,
    back: {
      kind: "back",
      artwork: exactArtwork(cover, "back_cover_art", cover.back.artworkAssetId),
      text: coverText(
        [
          ["synopsis", cover.back.synopsis],
          ["brand_line", cover.back.brandLine],
        ],
        cover.back.region,
        "body",
        16,
      ),
    },
    front: {
      kind: "front",
      artwork: exactArtwork(cover, "cover_art", cover.front.artworkAssetId),
      text: coverText(
        [
          ["title", cover.front.title],
          ["child_display_name", cover.front.childDisplayName],
          ["environment_line", cover.front.environmentLine],
        ],
        cover.front.region,
        "heading",
        24,
      ),
    },
  };
}

export function approvedCoverTextSamples(
  content: ApprovedCoverContent,
): string[] {
  return [...content.front.text.segments, ...content.back.text.segments].map(
    (segment) => segment.value,
  );
}

export function toPreviewCoverTextBlock(
  content: ApprovedCoverTextContent,
): PreviewCoverTextBlock {
  const value = {
    region: content.region,
    fontSizePt: content.fontSizePt,
    aid: content.aid,
  };
  return content.style === "heading"
    ? { ...value, heading: content.text }
    : { ...value, body: content.text };
}

function exactArtwork(
  cover: CoverCompositionVersion,
  role: "cover_art" | "back_cover_art",
  assetId: string | null,
): ApprovedCoverArtwork | null {
  if (assetId === null) return null;
  const matches = cover.sourceAssets.filter(
    (source) => source.role === role && source.assetId === assetId,
  );
  if (matches.length !== 1) throw new Error("COVER_CONTENT_SOURCE_INVALID");
  return { assetId, checksum: matches[0].checksum };
}

function coverText(
  values: ReadonlyArray<
    readonly [ApprovedCoverTextSegment["role"], string | null]
  >,
  region: LayoutNormalizedRegion,
  style: ApprovedCoverTextContent["style"],
  fontSizePt: number,
): ApprovedCoverTextContent {
  const segments = values.flatMap(([role, value]) =>
    value === null ? [] : [{ role, value }],
  );
  return {
    text: segments.map((segment) => segment.value).join("\n"),
    segments,
    region,
    fontSizePt,
    style,
    aid: "panel",
  };
}
