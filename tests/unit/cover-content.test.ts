import { describe, expect, it } from "vitest";

import {
  compileApprovedCoverContent,
  toPreviewCoverTextBlock,
} from "../../src/domain/layout/cover-content.js";
import type { CoverCompositionVersion } from "../../src/domain/layout/schemas.js";

const id = (suffix: string) => `01J00000000000000000000${suffix}`;
const hash = (character: string) => character.repeat(64);

describe("approved cover content", () => {
  it("normalizes every approved front/back field once with exact layout and art evidence", () => {
    const cover = fixtureCover();

    const content = compileApprovedCoverContent(cover);

    expect(content).toEqual({
      compositionVersionId: cover.id,
      compositionHash: cover.compositionHash,
      brandTemplateHash: cover.brandTemplateHash,
      fontManifestHash: cover.fontManifestHash,
      back: {
        kind: "back",
        artwork: { assetId: id("08"), checksum: hash("8") },
        text: {
          text: "ملخص الحكاية كما وافق عليه العميل\nحكايتي — صنعت بحب",
          segments: [
            {
              role: "synopsis",
              value: "ملخص الحكاية كما وافق عليه العميل",
            },
            { role: "brand_line", value: "حكايتي — صنعت بحب" },
          ],
          region: { x: 0.08, y: 0.56, width: 0.84, height: 0.32 },
          fontSizePt: 16,
          style: "body",
          aid: "panel",
        },
      },
      front: {
        kind: "front",
        artwork: { assetId: id("07"), checksum: hash("7") },
        text: {
          text: "رحلة نور\nنور\nفي حديقة الليمون",
          segments: [
            { role: "title", value: "رحلة نور" },
            { role: "child_display_name", value: "نور" },
            { role: "environment_line", value: "في حديقة الليمون" },
          ],
          region: { x: 0.12, y: 0.08, width: 0.76, height: 0.3 },
          fontSizePt: 24,
          style: "heading",
          aid: "panel",
        },
      },
    });

    expect(
      previewSemantics(toPreviewCoverTextBlock(content.front.text)),
    ).toEqual(renderSemantics(content.front.text));
    expect(
      previewSemantics(toPreviewCoverTextBlock(content.back.text)),
    ).toEqual(renderSemantics(content.back.text));
  });

  it("keeps absent optional copy/art absent without inventing replacements", () => {
    const cover = fixtureCover();
    cover.front.environmentLine = null;
    cover.back.synopsis = null;
    cover.back.artworkAssetId = null;
    cover.sourceAssets = cover.sourceAssets.filter(
      (source) => source.role !== "back_cover_art",
    );

    const content = compileApprovedCoverContent(cover);

    expect(content.front.text.text).toBe("رحلة نور\nنور");
    expect(content.back.text.text).toBe("حكايتي — صنعت بحب");
    expect(content.back.artwork).toBeNull();
  });

  it("fails closed when approved artwork has no exact pinned checksum", () => {
    const cover = fixtureCover();
    cover.sourceAssets = cover.sourceAssets.filter(
      (source) => source.role !== "back_cover_art",
    );

    expect(() => compileApprovedCoverContent(cover)).toThrow(
      "COVER_CONTENT_SOURCE_INVALID",
    );
  });
});

function previewSemantics(block: ReturnType<typeof toPreviewCoverTextBlock>) {
  return {
    text: block.heading ?? block.body ?? "",
    region: block.region,
    fontSizePt: block.fontSizePt,
    style:
      block.heading === undefined ? ("body" as const) : ("heading" as const),
    aid: block.aid,
  };
}

function renderSemantics(
  content: ReturnType<typeof compileApprovedCoverContent>["front"]["text"],
) {
  return {
    text: content.text,
    region: content.region,
    fontSizePt: content.fontSizePt,
    style: content.style,
    aid: content.aid,
  };
}

function fixtureCover(): CoverCompositionVersion {
  return {
    id: id("01"),
    schemaVersion: 1,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    projectId: id("02"),
    compositionProfileId: id("03"),
    compositionProfileHash: hash("3"),
    previousVersionId: null,
    projectVersionId: id("04"),
    compositionSourcePolicyVersion: "hekayati.composition-source.v1",
    selectionSource: "operator",
    textSources: [
      {
        role: "cover_title",
        entityId: id("02"),
        versionId: id("04"),
        contentHash: hash("4"),
      },
    ],
    sourceAssets: [
      { role: "cover_art", assetId: id("07"), checksum: hash("7") },
      {
        role: "back_cover_art",
        assetId: id("08"),
        checksum: hash("8"),
      },
    ],
    front: {
      title: "رحلة نور",
      childDisplayName: "نور",
      environmentLine: "في حديقة الليمون",
      artworkAssetId: id("07"),
      region: { x: 0.12, y: 0.08, width: 0.76, height: 0.3 },
    },
    back: {
      synopsis: "ملخص الحكاية كما وافق عليه العميل",
      brandLine: "حكايتي — صنعت بحب",
      artworkAssetId: id("08"),
      region: { x: 0.08, y: 0.56, width: 0.84, height: 0.32 },
    },
    brandTemplateHash: hash("5"),
    fontManifestHash: hash("6"),
    warnings: [],
    acceptance: "ready",
    compositionHash: hash("9"),
  };
}
