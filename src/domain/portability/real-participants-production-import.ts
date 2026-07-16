import { previewOutputSchema } from "../layout/schemas.js";
import {
  printerProfileVersionSchema,
  printArtifactSchema,
} from "../print/schemas.js";
import type { BaseDocument } from "../repository/document-store.js";
import type { PortabilityImportValidationContext } from "./participants.js";

export function validatePreviewOutputImport(
  document: Readonly<BaseDocument>,
  context: PortabilityImportValidationContext,
): void {
  const output = previewOutputSchema.parse(document);
  requirePdfFacts(context, output.assetId, "pdf_preview");
}

export function validatePrinterProfileImport(
  document: Readonly<BaseDocument>,
  context: PortabilityImportValidationContext,
): void {
  const profile = printerProfileVersionSchema.parse(document);
  if (profile.color.mode === "cmyk") {
    const icc = requireMediaFacts(context, profile.color.iccAssetId);
    if (
      icc.role !== "icc_profile" ||
      icc.sha256 !== profile.color.iccChecksum ||
      icc.inspection.kind !== "icc" ||
      icc.inspection.checksum !== profile.color.iccChecksum
    )
      importFailure("PORTABILITY_IMPORT_PROFILE_ICC_FACTS_INVALID");
  }
  if (profile.coverTemplate) {
    const template = requireMediaFacts(context, profile.coverTemplate.assetId);
    if (
      template.role !== "printer_template" ||
      template.sha256 !== profile.coverTemplate.checksum ||
      template.inspection.kind !== "pdf"
    )
      importFailure("PORTABILITY_IMPORT_PROFILE_TEMPLATE_FACTS_INVALID");
  }
}

export function validatePrintArtifactImport(
  document: Readonly<BaseDocument>,
  context: PortabilityImportValidationContext,
): void {
  const artifact = printArtifactSchema.parse(document);
  const expectedRole =
    artifact.kind === "interior" ? "pdf_interior" : "pdf_cover";
  const facts = requirePdfFacts(context, artifact.assetId, expectedRole);
  if (facts.sha256 !== artifact.checksum || facts.bytes !== artifact.bytes)
    importFailure("PORTABILITY_IMPORT_PRINT_ARTIFACT_FACTS_INVALID");
}

function requirePdfFacts(
  context: PortabilityImportValidationContext,
  assetId: string,
  role: string,
) {
  const facts = requireMediaFacts(context, assetId);
  if (facts.role !== role || facts.inspection.kind !== "pdf")
    importFailure("PORTABILITY_IMPORT_PDF_OWNER_FACTS_INVALID");
  return facts;
}

function requireMediaFacts(
  context: PortabilityImportValidationContext,
  assetId: string,
) {
  const facts = context.media("asset", assetId);
  if (!facts) importFailure("PORTABILITY_IMPORT_MEDIA_FACTS_MISSING");
  return facts;
}

function importFailure(code: string): never {
  throw new Error(code);
}
