import { createHash } from "node:crypto";

import { canonicalJson } from "../../contracts/canonical-json.js";

export interface TextSourceHashInput {
  role: string;
  entityId: string;
  versionId: string;
  contentHash: string;
}

export interface SourceAssetHashInput {
  role: string;
  assetId: string;
  checksum: string;
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createPageContentHash(input: {
  textSources: readonly TextSourceHashInput[];
  sourceAssets: readonly SourceAssetHashInput[];
}): string {
  return hashCanonical({
    textSources: sortedTextSources(input.textSources),
    sourceAssets: sortedSourceAssets(input.sourceAssets),
  });
}

export function createCompositionInputHash(input: {
  compositionProfileHash: string;
  projectVersionId: string;
  pageContentHash: string;
  reviewHash?: string | null;
  compositionSourcePolicyVersion?: string | null;
  selectionSource: string;
  templateVersion: string;
  typographySettingsHash: string;
  fontManifestHash: string;
  textSources: readonly TextSourceHashInput[];
  sourceAssets: readonly SourceAssetHashInput[];
}): string {
  return hashCanonical({
    ...input,
    textSources: sortedTextSources(input.textSources),
    sourceAssets: sortedSourceAssets(input.sourceAssets),
  });
}

export function createLayoutHash(input: {
  compositionInputHash: string;
  requestedPlacement: string;
  resolvedPlacement: string;
  resolvedRegion: unknown;
  readabilityAid: string;
  fontSizePt: number;
  overflow: boolean;
  warnings: readonly string[];
  bubbles: readonly unknown[];
  measurementHash: string;
  layoutPolicyVersion: string;
  rendererVersion: string;
}): string {
  return hashCanonical(input);
}

export function createCustomerContentHash(input: {
  compositionProfileHash: string;
  coverCompositionHash: string;
  pages: readonly {
    pageNumber: number;
    pageContentHash: string;
    layoutHash: string;
    textSources: readonly TextSourceHashInput[];
    sourceAssets: readonly SourceAssetHashInput[];
  }[];
}): string {
  return hashCanonical({
    ...input,
    pages: input.pages.map((page) => ({
      ...page,
      textSources: sortedTextSources(page.textSources),
      sourceAssets: sortedSourceAssets(page.sourceAssets),
    })),
  });
}

export function createPreviewDerivativePolicyHash(input: {
  version: string;
  format: "webp" | "jpeg";
  quality: number;
  targetPpi: number;
  sizing: "exact_placed_size";
}): string {
  return hashCanonical(input);
}

export function createPageMapHash(
  pages: readonly {
    pageNumber: number;
    pageId: string;
    layoutVersionId: string;
  }[],
): string {
  return hashCanonical(pages);
}

export function createApprovalBundleHash(input: {
  previewOutputId: string;
  customerContentHash: string;
  reviewEvidenceHash: string;
  watermarkSettingsHash: string;
  previewDerivativePolicyHash: string;
}): string {
  return hashCanonical(input);
}

export function createContentAuthorizationHash(input: {
  customerContentHash: string;
  previewOutputId: string;
  approvalCycleId: string;
  approvalGateJobId: string;
  approvedOutcome: "approved";
  reviewEvidenceHash: string;
}): string {
  return hashCanonical(input);
}

function sortedTextSources(
  sources: readonly TextSourceHashInput[],
): TextSourceHashInput[] {
  return [...sources].sort((left, right) => {
    const a = `${left.role}:${left.entityId}:${left.versionId}`;
    const b = `${right.role}:${right.entityId}:${right.versionId}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function sortedSourceAssets(
  sources: readonly SourceAssetHashInput[],
): SourceAssetHashInput[] {
  return [...sources].sort((left, right) => {
    const a = `${left.role}:${left.assetId}`;
    const b = `${right.role}:${right.assetId}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
