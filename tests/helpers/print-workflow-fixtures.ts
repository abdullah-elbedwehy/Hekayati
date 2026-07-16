import sharp from "sharp";

import { CreativeRepositories } from "../../src/domain/creative/repositories.js";
import {
  compileCoverGeometry,
  compileInteriorGeometry,
  compileOutputPageMap,
} from "../../src/domain/print/geometry.js";
import type { PrintCompilerPort } from "../../src/jobs/print-definitions.js";
import type {
  PrintCoverDocument,
  PrintDocumentImage,
  PrintInteriorDocument,
} from "../../src/pdf/print-document.js";
import type { DocumentStore } from "../../src/domain/repository/document-store.js";

export function addSyntheticReviewedPage(
  store: DocumentStore,
  input: { id: string; projectId: string; at: string },
): void {
  new CreativeRepositories(store).pages.insert({
    id: input.id,
    schemaVersion: 2,
    createdAt: input.at,
    updatedAt: input.at,
    revision: 0,
    projectId: input.projectId,
    pageNumber: 3,
    storyPageIndex: 1,
    kind: "story",
    locked: false,
    reviewStatus: "approved",
    staleState: "current",
    staleReasons: [],
    currentTextVersionId: null,
    currentPromptVersionId: null,
    currentIllustrationVersionId: null,
  });
}

export function printableCompiler(
  image: PrintDocumentImage,
): PrintCompilerPort {
  return {
    compileInterior: async (context) => {
      const map = compileOutputPageMap(
        context.snapshot.orderedInteriorPages.map((page) => ({
          customerPageNumber: page.pageNumber,
          pageId: page.pageId,
        })),
        context.profileVersion.requiredBlankPages,
      );
      return {
        kind: "interior",
        profile: context.profileVersion,
        geometry: compileInteriorGeometry(context.profileVersion),
        sourceSnapshotHash: context.sourceSnapshotHash,
        fontManifestHash: context.output.fontManifestHash,
        pages: map.map((entry, index) => ({
          map: entry,
          pageKind: index === 0 ? "title" : "story",
          image,
          text: {
            text:
              index === 0
                ? "حِكايَة لَيْلَى في مَلْعَب اللَّيْمُون"
                : `قالت ليلى: لَأَلْعَبَنَّ مع Mira في الصفحة ${index + 1}!`,
            region: { x: 0.1, y: 0.66, width: 0.8, height: 0.24 },
            fontSizePt: 20,
            style: index === 0 ? "heading" : "body",
            aid: "panel",
          },
          bubbles: [],
        })),
      } satisfies PrintInteriorDocument;
    },
    compileCover: async (context) =>
      ({
        kind: "cover",
        profile: context.profileVersion,
        geometry: compileCoverGeometry(context.profileVersion),
        sourceSnapshotHash: context.sourceSnapshotHash,
        fontManifestHash: context.cover.fontManifestHash,
        panels: [
          {
            kind: "back",
            image: null,
            text: coverText("حكايتي — حكاية معمولة بحب"),
          },
          { kind: "spine", image: null, text: null },
          { kind: "front", image, text: coverText("حِكايَة لَيْلَى") },
        ],
      }) satisfies PrintCoverDocument,
  };
}

export async function syntheticPrintImage(
  width = 2_600,
  height = 3_677,
): Promise<Buffer> {
  return await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 212, b: 59 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height * 0.37}" r="${width * 0.28}" fill="#2F9E6A"/><path d="M${width * 0.12} ${height * 0.86} Q${width / 2} ${height * 0.63} ${width * 0.88} ${height * 0.86}" fill="#FF8A1F"/></svg>`,
        ),
      },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
}

function coverText(text: string) {
  return {
    text,
    region: { x: 0.1, y: 0.1, width: 0.8, height: 0.25 },
    fontSizePt: 18,
    style: "heading" as const,
    aid: "panel" as const,
  };
}
