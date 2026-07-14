import { createHash } from "node:crypto";

import type { AssetRecord } from "../assets/asset-store.js";
import type {
  LibraryService,
  ProviderPhotoReferenceDraft,
} from "../domain/library/index.js";
import {
  resolvedImageRequestSchema,
  type ImageRequestDraft,
  type ProviderEligibleReference,
  type ResolvedImageRequest,
} from "../providers/contract.js";
import { JobError } from "./errors.js";
import type {
  GuardedReference,
  ImageReferenceResolver,
} from "./pre-dispatch.js";

type SheetReference = Extract<
  ProviderEligibleReference,
  { source: "approved_character_sheet" }
>;

export interface ApprovedSheetMetadata {
  characterSheetId: string;
  customerId: string;
  familyId: string;
  characterId: string;
  characterVersionId: string;
  appearance:
    | { type: "base"; lookId: null; lookVersionId: null }
    | { type: "shared_look"; lookId: string; lookVersionId: string };
  sheetAssetId: string;
  lineageSource: "description_only" | "photo_derived";
}

export type ApprovedSheetReadResult =
  | { ok: true; value: ApprovedSheetMetadata }
  | {
      ok: false;
      code:
        | "SHEET_NOT_FOUND"
        | "SHEET_NOT_APPROVED"
        | "SHEET_REFERENCE_MISMATCH"
        | "SHEET_LINEAGE_INVALID";
    };

export interface ApprovedSheetLineageReader {
  resolveApprovedSheetReferenceMetadata(
    reference: Readonly<SheetReference>,
  ): ApprovedSheetReadResult | Promise<ApprovedSheetReadResult>;
}

interface LibraryReferencePort {
  resolveProviderPhotoReferenceMetadata(input: ProviderPhotoReferenceDraft): {
    providerAssetId: string;
  };
  assertPhotoConsent(customerId: string, use: "photo_derived_sheet"): void;
}

interface AssetReadPort {
  get(assetId: string): AssetRecord | null;
  read(assetId: string): Promise<Uint8Array>;
}

export class LibraryImageReferenceResolver implements ImageReferenceResolver {
  constructor(
    private readonly library: LibraryReferencePort,
    private readonly assets: AssetReadPort,
    private readonly sheets?: ApprovedSheetLineageReader,
  ) {}

  async inspect(
    draft: Readonly<ImageRequestDraft>,
  ): Promise<readonly GuardedReference[]> {
    const inspected: GuardedReference[] = [];
    for (const reference of draft.referenceImages) {
      inspected.push(
        reference.source === "reference_photo"
          ? this.inspectPhoto(reference)
          : await this.inspectSheet(reference),
      );
    }
    return inspected;
  }

  async load(
    draft: Readonly<ImageRequestDraft>,
    references: readonly GuardedReference[],
  ): Promise<ResolvedImageRequest> {
    if (references.length !== draft.referenceImages.length)
      throw new JobError("JOB_REFERENCE_SNAPSHOT_MISMATCH");
    const resolved = [];
    for (const reference of references) {
      const bytes = await this.assets.read(reference.selectedAssetId);
      if (sha256(bytes) !== reference.expectedSha256)
        throw new JobError("JOB_REFERENCE_CHECKSUM_MISMATCH");
      resolved.push({
        source: reference.source,
        sourceRecordId: reference.sourceRecordId,
        customerId: reference.customerId,
        familyId: reference.familyId,
        characterId: reference.characterId,
        versionRefs: reference.versionRefs,
        provenanceAssetId: reference.provenanceAssetId,
        mime: reference.mime,
        bytes,
      });
    }
    return resolvedImageRequestSchema.parse({
      ...draft,
      schemaVersion: 1,
      referenceImages: resolved,
    });
  }

  private inspectPhoto(
    reference: Extract<
      ProviderEligibleReference,
      { source: "reference_photo" }
    >,
  ): GuardedReference {
    const metadata =
      this.library.resolveProviderPhotoReferenceMetadata(reference);
    if (metadata.providerAssetId !== reference.providerAssetId)
      throw new JobError("JOB_REFERENCE_ASSET_MISMATCH");
    const asset = this.requireAsset(reference.providerAssetId);
    if (
      asset.role !== "reference_photo" ||
      asset.origin !== "derived" ||
      asset.exifStripped !== true
    )
      throw new JobError("JOB_REFERENCE_ASSET_INELIGIBLE");
    return guardedPhoto(reference, asset);
  }

  private async inspectSheet(
    reference: SheetReference,
  ): Promise<GuardedReference> {
    if (!this.sheets) throw new JobError("JOB_SHEET_LINEAGE_READER_MISSING");
    const resolved =
      await this.sheets.resolveApprovedSheetReferenceMetadata(reference);
    if (!resolved.ok) throw new JobError(resolved.code);
    assertSheetMetadata(reference, resolved.value);
    if (resolved.value.lineageSource === "photo_derived")
      this.library.assertPhotoConsent(
        resolved.value.customerId,
        "photo_derived_sheet",
      );
    const asset = this.requireAsset(resolved.value.sheetAssetId);
    if (asset.role !== "sheet_view")
      throw new JobError("JOB_SHEET_ASSET_INELIGIBLE");
    return guardedSheet(resolved.value, asset);
  }

  private requireAsset(assetId: string): AssetRecord & {
    mime: "image/jpeg" | "image/png";
  } {
    const asset = this.assets.get(assetId);
    if (!asset) throw new JobError("JOB_REFERENCE_ASSET_MISSING");
    if (asset.mime !== "image/jpeg" && asset.mime !== "image/png")
      throw new JobError("JOB_REFERENCE_MIME_INELIGIBLE");
    return asset as AssetRecord & { mime: "image/jpeg" | "image/png" };
  }
}

export function createLibraryImageReferenceResolver(
  library: LibraryService,
  assets: AssetReadPort,
  sheets?: ApprovedSheetLineageReader,
): LibraryImageReferenceResolver {
  return new LibraryImageReferenceResolver(library, assets, sheets);
}

function guardedPhoto(
  reference: Extract<ProviderEligibleReference, { source: "reference_photo" }>,
  asset: AssetRecord & { mime: "image/jpeg" | "image/png" },
): GuardedReference {
  return {
    source: "reference_photo",
    sourceRecordId: reference.referencePhotoId,
    customerId: reference.customerId,
    familyId: reference.familyId,
    characterId: reference.characterId,
    versionRefs: {
      characterVersionId: reference.owner.characterVersionId,
      ...(reference.owner.type === "look"
        ? { lookVersionId: reference.owner.lookVersionId }
        : {}),
    },
    selectedAssetId: asset.id,
    provenanceAssetId: asset.id,
    expectedSha256: asset.sha256,
    mime: asset.mime,
  };
}

function guardedSheet(
  sheet: ApprovedSheetMetadata,
  asset: AssetRecord & { mime: "image/jpeg" | "image/png" },
): GuardedReference {
  return {
    source: "approved_character_sheet",
    sourceRecordId: sheet.characterSheetId,
    customerId: sheet.customerId,
    familyId: sheet.familyId,
    characterId: sheet.characterId,
    versionRefs: {
      characterVersionId: sheet.characterVersionId,
      ...(sheet.appearance.type === "shared_look"
        ? { lookVersionId: sheet.appearance.lookVersionId }
        : {}),
    },
    selectedAssetId: asset.id,
    provenanceAssetId: asset.id,
    expectedSha256: asset.sha256,
    mime: asset.mime,
  };
}

function assertSheetMetadata(
  reference: SheetReference,
  sheet: ApprovedSheetMetadata,
): void {
  const expected = [
    reference.characterSheetId,
    reference.customerId,
    reference.familyId,
    reference.characterId,
    reference.characterVersionId,
    reference.appearance.type,
    reference.appearance.lookId,
    reference.appearance.lookVersionId,
    reference.sheetAssetId,
  ];
  const actual = [
    sheet.characterSheetId,
    sheet.customerId,
    sheet.familyId,
    sheet.characterId,
    sheet.characterVersionId,
    sheet.appearance.type,
    sheet.appearance.lookId,
    sheet.appearance.lookVersionId,
    sheet.sheetAssetId,
  ];
  if (expected.some((value, index) => value !== actual[index]))
    throw new JobError("SHEET_REFERENCE_MISMATCH");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
