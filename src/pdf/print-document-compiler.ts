import sharp from "sharp";

import type { AssetRecord, AssetStore } from "../assets/asset-store.js";
import { AuthoringRepositories } from "../domain/authoring/repositories.js";
import { CreativeRepositories } from "../domain/creative/repositories.js";
import type { Page } from "../domain/creative/schemas.js";
import {
  type ApprovedCoverArtwork,
  type ApprovedCoverContent,
  compileApprovedCoverContent,
} from "../domain/layout/cover-content.js";
import {
  compileCoverGeometry,
  compileInteriorGeometry,
  compileOutputPageMap,
} from "../domain/print/geometry.js";
import { failPrint } from "../domain/print/errors.js";
import type { MaterializationContext } from "../domain/print/workflow.js";
import { LayoutRepositories } from "../domain/layout/repositories.js";
import type {
  CoverCompositionVersion,
  LayoutVersion,
  PreviewInteriorPage,
} from "../domain/layout/schemas.js";
import type { DocumentStore } from "../domain/repository/document-store.js";
import type {
  PrintCoverDocument,
  PrintDocumentImage,
  PrintInteriorDocument,
  PrintInteriorPageContent,
  PrintTextContent,
} from "./print-document.js";

export class PrintDocumentCompiler {
  private readonly authoring: AuthoringRepositories;
  private readonly creative: CreativeRepositories;
  private readonly layout: LayoutRepositories;

  constructor(
    store: DocumentStore,
    private readonly assets: AssetStore,
  ) {
    this.authoring = new AuthoringRepositories(store);
    this.creative = new CreativeRepositories(store);
    this.layout = new LayoutRepositories(store);
  }

  async compileInterior(
    context: MaterializationContext,
  ): Promise<PrintInteriorDocument> {
    const snapshot = context.snapshot;
    const customerPages = snapshot.orderedInteriorPages.map((page) => ({
      customerPageNumber: page.pageNumber,
      pageId: page.pageId,
    }));
    const map = compileOutputPageMap(
      customerPages,
      context.profileVersion.requiredBlankPages,
    );
    const pageById = new Map(
      snapshot.orderedInteriorPages.map((page) => [page.pageId, page]),
    );
    const imageCache = new Map<string, PrintDocumentImage>();
    const pages: PrintInteriorPageContent[] = [];
    for (const entry of map) {
      if (entry.kind === "printer_blank") {
        pages.push({
          map: entry,
          pageKind: "printer_blank",
          image: null,
          text: null,
          bubbles: [],
        });
        continue;
      }
      const approved = pageById.get(entry.pageId);
      if (!approved) failPrint("PRINT_RUN_STALE");
      pages.push(
        await this.compileCustomerPage(approved, entry, context, imageCache),
      );
    }
    return {
      kind: "interior",
      profile: context.profileVersion,
      geometry: compileInteriorGeometry(context.profileVersion),
      sourceSnapshotHash: context.sourceSnapshotHash,
      fontManifestHash: context.output.fontManifestHash,
      pages,
    };
  }

  async compileCover(
    context: MaterializationContext,
  ): Promise<PrintCoverDocument> {
    const cover = exactCoverContent(context.cover);
    const geometry = compileCoverGeometry(context.profileVersion);
    const { front, back } = await this.compileCoverImages(context, cover);
    return {
      kind: "cover",
      profile: context.profileVersion,
      geometry,
      sourceSnapshotHash: context.sourceSnapshotHash,
      fontManifestHash: cover.fontManifestHash,
      panels: [
        {
          kind: "back",
          image: back,
          text: cover.back.text,
        },
        { kind: "spine", image: null, text: null },
        {
          kind: "front",
          image: front,
          text: cover.front.text,
        },
      ],
    };
  }

  private async compileCoverImages(
    context: MaterializationContext,
    cover: ApprovedCoverContent,
  ): Promise<{
    front: PrintDocumentImage | null;
    back: PrintDocumentImage | null;
  }> {
    const cache = new Map<string, PrintDocumentImage>();
    const image = (artwork: ApprovedCoverArtwork) =>
      this.coverImage(
        artwork,
        context.profileVersion.trim.widthMm,
        context.profileVersion.trim.heightMm,
        cache,
      );
    const [front, back] = await Promise.all([
      cover.front.artwork ? image(cover.front.artwork) : null,
      cover.back.artwork ? image(cover.back.artwork) : null,
    ]);
    return { front, back };
  }

  private async compileCustomerPage(
    approved: PreviewInteriorPage,
    map: Extract<
      ReturnType<typeof compileOutputPageMap>[number],
      { kind: "customer" }
    >,
    context: MaterializationContext,
    cache: Map<string, PrintDocumentImage>,
  ): Promise<PrintInteriorPageContent> {
    const page = this.creative.pages.get(approved.pageId);
    const layout = this.layout.layoutVersions.get(approved.layoutVersionId);
    if (
      !page ||
      !layout ||
      page.projectId !== context.snapshot.projectId ||
      page.pageNumber !== approved.pageNumber ||
      layout.pageId !== page.id ||
      layout.layoutHash !== approved.layoutHash ||
      layout.inputSnapshot.pageContentHash !== approved.pageContentHash ||
      layout.inputSnapshot.compositionInputHash !==
        approved.compositionInputHash ||
      layout.inputSnapshot.textVersionId !== approved.textVersionId ||
      layout.inputSnapshot.illustrationVersionId !==
        approved.illustrationVersionId ||
      layout.overflow ||
      layout.acceptance !== "ready"
    )
      failPrint("PRINT_RUN_STALE");
    const image = await this.pageImage(
      approved,
      context.profileVersion.trim.widthMm + context.profileVersion.bleedMm * 2,
      context.profileVersion.trim.heightMm + context.profileVersion.bleedMm * 2,
      cache,
    );
    return {
      map,
      pageKind: page.kind,
      image,
      text: this.pageText(page, approved, layout, context),
      bubbles: layout.bubbles.map((bubble) => ({
        speakerLabel: bubble.speakerLabel,
        text: bubble.text,
        region: bubble.region,
      })),
    };
  }

  private pageText(
    page: Page,
    approved: PreviewInteriorPage,
    layout: LayoutVersion,
    context: MaterializationContext,
  ): PrintTextContent {
    const value = this.exactPageText(page, approved, context.cover);
    return {
      text: value,
      region: layout.resolvedRegion,
      fontSizePt: layout.fontSizePt,
      style:
        page.kind === "title" || page.kind === "ending2" ? "heading" : "body",
      aid: layout.readabilityAid,
    };
  }

  private exactPageText(
    page: Page,
    approved: PreviewInteriorPage,
    cover: CoverCompositionVersion,
  ): string {
    if (page.kind === "story") {
      const text = approved.textVersionId
        ? this.creative.pageTexts.get(approved.textVersionId)
        : null;
      if (!text || text.pageId !== page.id) failPrint("PRINT_RUN_STALE");
      return text.narrative;
    }
    const projectVersion = this.authoring.projectVersions.get(
      cover.projectVersionId,
    );
    if (!projectVersion || projectVersion.projectId !== cover.projectId)
      failPrint("PRINT_RUN_STALE");
    if (page.kind === "title") return cover.front.title;
    if (page.kind === "dedication")
      return projectVersion.storyConfig.dedicationText;
    if (page.kind === "ending1")
      return projectVersion.storyConfig.endingPages.farewellText;
    return `${cover.back.brandLine}\n${cover.front.childDisplayName}`;
  }

  private async pageImage(
    approved: PreviewInteriorPage,
    placedWidthMm: number,
    placedHeightMm: number,
    cache: Map<string, PrintDocumentImage>,
  ): Promise<PrintDocumentImage | null> {
    const source = approved.sourceAssets.find(
      (candidate) => candidate.role === "artwork",
    );
    return source
      ? this.exactImage(
          source.assetId,
          source.checksum,
          placedWidthMm,
          placedHeightMm,
          cache,
        )
      : null;
  }

  private async coverImage(
    artwork: ApprovedCoverArtwork,
    placedWidthMm: number,
    placedHeightMm: number,
    cache: Map<string, PrintDocumentImage>,
  ): Promise<PrintDocumentImage> {
    return this.exactImage(
      artwork.assetId,
      artwork.checksum,
      placedWidthMm,
      placedHeightMm,
      cache,
    );
  }

  private async exactImage(
    assetId: string,
    checksum: string,
    placedWidthMm: number,
    placedHeightMm: number,
    cache: Map<string, PrintDocumentImage>,
  ): Promise<PrintDocumentImage> {
    const key = `${assetId}:${checksum}:${placedWidthMm}:${placedHeightMm}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const record = this.assets.get(assetId);
    if (!record || record.sha256 !== checksum || !fullResolutionRole(record))
      failPrint("PRINT_RUN_STALE");
    const bytes = await this.assets.read(assetId);
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    const widthPx = metadata.width;
    const heightPx = metadata.height;
    const mime = exactImageMime(record);
    if (!widthPx || !heightPx || !mime) failPrint("PRINT_RUN_STALE");
    const image: PrintDocumentImage = {
      bytes,
      mime,
      widthPx,
      heightPx,
      assetId,
      checksum,
      effectivePpi: Math.min(
        widthPx / (placedWidthMm / 25.4),
        heightPx / (placedHeightMm / 25.4),
      ),
    };
    cache.set(key, image);
    return image;
  }
}

function exactCoverContent(
  cover: CoverCompositionVersion,
): ApprovedCoverContent {
  try {
    return compileApprovedCoverContent(cover);
  } catch {
    failPrint("PRINT_RUN_STALE");
  }
}

function fullResolutionRole(record: AssetRecord): boolean {
  return record.role === "illustration" || record.role === "sheet_view";
}

function exactImageMime(
  record: AssetRecord,
): "image/png" | "image/jpeg" | null {
  if (record.mime === "image/png") return "image/png";
  if (record.mime === "image/jpeg") return "image/jpeg";
  return null;
}
