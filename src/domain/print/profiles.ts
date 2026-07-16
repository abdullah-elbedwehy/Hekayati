import { createHash } from "node:crypto";

import { ulid } from "ulid";
import { z } from "zod";

import type { AssetStore } from "../../assets/asset-store.js";
import {
  inspectIccProfile,
  requireCmykIccProfile,
  type IccProfileFacts,
} from "../../print/icc.js";
import {
  inspectCoverTemplatePdf,
  type CoverTemplateInspection,
  type CoverTemplateTools,
} from "../../print/template.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type { Project } from "../authoring/schemas.js";
import type { AppendChangeEventInput } from "../creative/invalidation.js";
import { checkCompositionCompatibility } from "../layout/compatibility.js";
import { LayoutRepositories } from "../layout/repositories.js";
import type { DocumentStore } from "../repository/document-store.js";
import { failPrint } from "./errors.js";
import { isValidCmykOutputProfileAsset } from "./profile-assets.js";
import { PrintRepositories } from "./repositories.js";
import {
  finalizePrinterProfileVersion,
  coverTemplateFactsSchema,
  printNormalizedRegionSchema,
  printerProfileDraftSchema,
  type PrinterProfile,
  type PrinterProfileDraft,
  type PrinterProfileVersion,
} from "./schemas.js";

const entityIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const ownerSchema = z
  .object({ customerId: entityIdSchema, familyId: entityIdSchema })
  .strict();

const createInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    draft: printerProfileDraftSchema,
  })
  .strict();

const updateInputSchema = z
  .object({
    profileId: entityIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(160),
    archived: z.boolean(),
    draft: printerProfileDraftSchema,
  })
  .strict();

const assignmentInputSchema = z
  .object({
    owner: ownerSchema,
    projectId: entityIdSchema,
    expectedProjectRevision: z.number().int().nonnegative(),
    profileId: entityIdSchema,
    expectedProfileRevision: z.number().int().nonnegative(),
    profileVersionId: entityIdSchema,
  })
  .strict();

const iccImportSchema = z
  .object({
    bytes: z.instanceof(Buffer).refine((bytes) => bytes.length > 0),
    requireCmyk: z.boolean(),
  })
  .strict();

const templateImportSchema = z
  .object({
    bytes: z.instanceof(Buffer).refine((bytes) => bytes.length > 0),
    backRegion: printNormalizedRegionSchema,
    spineRegion: printNormalizedRegionSchema,
    frontRegion: printNormalizedRegionSchema,
    toleranceMm: z.number().finite().min(0).max(2),
  })
  .strict();

export interface PrinterProfileServiceOptions {
  now?: () => string;
  idFactory?: () => string;
  invalidation?: {
    recordAndConsume(input: AppendChangeEventInput): unknown;
  };
}

export interface ProfileVersionResult {
  profile: PrinterProfile;
  version: PrinterProfileVersion;
}

export class PrinterProfileService {
  private readonly profiles: PrintRepositories;
  private readonly authoring: AuthoringRepositories;
  private readonly layout: LayoutRepositories;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly invalidation: PrinterProfileServiceOptions["invalidation"];

  constructor(
    private readonly store: DocumentStore,
    private readonly assets: AssetStore,
    options: PrinterProfileServiceOptions = {},
  ) {
    this.profiles = new PrintRepositories(store);
    this.authoring = new AuthoringRepositories(store);
    this.layout = new LayoutRepositories(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.invalidation = options.invalidation;
  }

  list(): Array<{ profile: PrinterProfile; version: PrinterProfileVersion }> {
    return this.profiles.profiles.list().map((profile) => ({
      profile,
      version: this.requireVersion(profile.currentVersionId),
    }));
  }

  create(input: {
    name: string;
    draft: PrinterProfileDraft;
  }): ProfileVersionResult {
    const parsed = createInputSchema.parse(input);
    this.assertIndexedAssets(parsed.draft);
    const at = this.now();
    const profileId = this.idFactory();
    const version = finalizePrinterProfileVersion({
      id: this.idFactory(),
      profileId,
      previousVersionId: null,
      createdAt: at,
      updatedAt: at,
      draft: parsed.draft,
    });
    const profile = {
      id: profileId,
      schemaVersion: 1 as const,
      createdAt: at,
      updatedAt: at,
      revision: 0,
      name: parsed.name,
      currentVersionId: version.id,
      archived: false,
    };
    return this.store.transaction(() => ({
      version: this.profiles.profileVersions.insert(version),
      profile: this.profiles.profiles.insert(profile),
    }));
  }

  update(input: {
    profileId: string;
    expectedRevision: number;
    name: string;
    archived: boolean;
    draft: PrinterProfileDraft;
  }): ProfileVersionResult {
    const parsed = updateInputSchema.parse(input);
    this.assertIndexedAssets(parsed.draft);
    const at = this.now();
    return this.store.transaction(() => {
      const current = this.requireProfile(parsed.profileId);
      if (current.revision !== parsed.expectedRevision)
        failPrint("PRINT_REVISION_CONFLICT");
      const version = finalizePrinterProfileVersion({
        id: this.idFactory(),
        profileId: current.id,
        previousVersionId: current.currentVersionId,
        createdAt: at,
        updatedAt: at,
        draft: parsed.draft,
      });
      this.profiles.profileVersions.insert(version);
      const profile = this.profiles.profiles.update(parsed.expectedRevision, {
        ...current,
        revision: current.revision + 1,
        updatedAt: at,
        name: parsed.name,
        archived: parsed.archived,
        currentVersionId: version.id,
      });
      this.invalidateAssignedProjects(
        current.id,
        current.currentVersionId,
        version.id,
        at,
        ["printerProfileVersion"],
      );
      return { profile, version };
    });
  }

  async importIcc(input: { bytes: Buffer; requireCmyk: boolean }): Promise<{
    asset: NonNullable<ReturnType<AssetStore["get"]>>;
    facts: IccProfileFacts;
  }> {
    const parsed = iccImportSchema.parse(input);
    const facts = parsed.requireCmyk
      ? requireCmykIccProfile(parsed.bytes)
      : inspectIccProfile(parsed.bytes);
    const asset = await this.assets.put({
      bytes: parsed.bytes,
      extension: "icc",
      mime: "application/vnd.iccprofile",
      role: "icc_profile",
      origin: "upload",
    });
    if (asset.sha256 !== facts.checksum)
      failPrint("PRINTER_PROFILE_ASSET_INVALID");
    return { asset, facts };
  }

  async importCoverTemplate(
    input: {
      bytes: Buffer;
      backRegion: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      spineRegion: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      frontRegion: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      toleranceMm: number;
    },
    tools: Partial<CoverTemplateTools> = {},
  ): Promise<{
    asset: NonNullable<ReturnType<AssetStore["get"]>>;
    inspection: CoverTemplateInspection;
    facts: z.infer<typeof coverTemplateFactsSchema>;
  }> {
    const parsed = templateImportSchema.parse(input);
    const inspection = await inspectCoverTemplatePdf(parsed.bytes, tools);
    const checksum = createHash("sha256").update(parsed.bytes).digest("hex");
    templateFacts(parsed, inspection, "00000000000000000000000000", checksum);
    const asset = await this.assets.put({
      bytes: parsed.bytes,
      extension: "pdf",
      mime: "application/pdf",
      role: "printer_template",
      origin: "upload",
    });
    const facts = templateFacts(parsed, inspection, asset.id, asset.sha256);
    return { asset, inspection, facts };
  }

  assignProject(input: {
    owner: { customerId: string; familyId: string };
    projectId: string;
    expectedProjectRevision: number;
    profileId: string;
    expectedProfileRevision: number;
    profileVersionId: string;
  }): Project {
    const parsed = assignmentInputSchema.parse(input);
    return this.store.transaction(() => this.assignParsed(parsed));
  }

  private assignParsed(parsed: z.infer<typeof assignmentInputSchema>): Project {
    const project = this.authoring.projects.get(parsed.projectId);
    if (!project) failPrint("PRINT_ENTITY_NOT_FOUND");
    if (
      project.customerId !== parsed.owner.customerId ||
      project.familyId !== parsed.owner.familyId
    )
      failPrint("PRINT_SCOPE_REJECTED");
    if (project.revision !== parsed.expectedProjectRevision)
      failPrint("PRINT_REVISION_CONFLICT");
    const profile = this.requireProfile(parsed.profileId);
    const version = this.requireVersion(parsed.profileVersionId);
    this.assertAssignableProfile(parsed, profile, version);
    this.assertCompositionCompatible(project, version);
    const previousVersionId = project.printerProfileId
      ? (this.profiles.profiles.get(project.printerProfileId)
          ?.currentVersionId ?? null)
      : null;
    const assigned = this.authoring.projects.update({
      ...project,
      revision: project.revision + 1,
      updatedAt: this.now(),
      printerProfileId: profile.id,
    });
    this.invalidateProject(
      assigned.id,
      previousVersionId,
      version.id,
      assigned.updatedAt,
      ["printerProfileAssignment"],
    );
    return this.authoring.projects.get(assigned.id) ?? assigned;
  }

  private invalidateAssignedProjects(
    profileId: string,
    fromVersionId: string | null,
    toVersionId: string,
    occurredAt: string,
    changedFields: string[],
  ): void {
    if (!this.invalidation) return;
    const projects = this.authoring.projects.queryByField(
      "printerProfileId",
      profileId,
    );
    const correlationId = this.idFactory();
    for (const project of projects)
      this.invalidateProject(
        project.id,
        fromVersionId,
        toVersionId,
        occurredAt,
        changedFields,
        correlationId,
      );
  }

  private invalidateProject(
    projectId: string,
    fromVersionId: string | null,
    toVersionId: string,
    occurredAt: string,
    changedFields: string[],
    correlationId = this.idFactory(),
  ): void {
    if (!this.invalidation) return;
    this.invalidation.recordAndConsume({
      id: this.idFactory(),
      entity: "printer_profile",
      entityId: projectId,
      fromVersionId,
      toVersionId,
      changeType: "printer_profile",
      matrixRow: "IM-14",
      changedFields,
      correlationId,
      occurredAt,
    });
  }

  private assertAssignableProfile(
    input: z.infer<typeof assignmentInputSchema>,
    profile: PrinterProfile,
    version: PrinterProfileVersion,
  ): void {
    if (
      profile.revision !== input.expectedProfileRevision ||
      profile.currentVersionId !== version.id
    )
      failPrint("PRINT_REVISION_CONFLICT");
    if (profile.archived) failPrint("PRINTER_PROFILE_ARCHIVED");
    if (version.readiness !== "ready")
      failPrint("PRINTER_PROFILE_INCOMPLETE", {
        blockingReasons: version.blockingReasons,
      });
    this.assertIndexedAssets(version);
  }

  private assertCompositionCompatible(
    project: Project,
    version: PrinterProfileVersion,
  ): void {
    const composition = this.layout.compositionProfiles.get(
      project.compositionProfileId,
    );
    if (!composition) failPrint("PRINT_ENTITY_NOT_FOUND");
    const compatibility = checkCompositionCompatibility(composition, {
      orientation: version.trim.orientation,
      trimWidthMm: version.trim.widthMm,
      trimHeightMm: version.trim.heightMm,
      safeContentRegion: version.safeContentRegion,
      printerOnly: {
        bleedMm: version.bleedMm,
        dpi: version.dpiMin,
        color: version.color.mode,
      },
    });
    if (!compatibility.compatible)
      failPrint("COMPOSITION_PROFILE_MISMATCH", compatibility);
  }

  private assertIndexedAssets(
    draft: Pick<PrinterProfileDraft, "color" | "coverTemplate">,
  ): void {
    if (draft.color.mode === "cmyk") {
      if (!this.assets.get(draft.color.iccAssetId))
        failPrint("PRINTER_PROFILE_ASSET_MISSING");
      if (
        !isValidCmykOutputProfileAsset(
          this.assets,
          draft.color.iccAssetId,
          draft.color.iccChecksum,
        )
      )
        failPrint("PRINTER_PROFILE_ASSET_INVALID");
    }
    if (draft.coverTemplate) {
      const asset = this.assets.get(draft.coverTemplate.assetId);
      if (!asset) failPrint("PRINTER_PROFILE_ASSET_MISSING");
      if (
        asset.role !== "printer_template" ||
        asset.mime !== "application/pdf" ||
        asset.sha256 !== draft.coverTemplate.checksum
      )
        failPrint("PRINTER_PROFILE_ASSET_INVALID");
    }
  }

  private requireProfile(id: string): PrinterProfile {
    const profile = this.profiles.profiles.get(id);
    if (!profile) failPrint("PRINTER_PROFILE_NOT_FOUND");
    return profile;
  }

  private requireVersion(id: string): PrinterProfileVersion {
    const version = this.profiles.profileVersions.get(id);
    if (!version) failPrint("PRINTER_PROFILE_VERSION_NOT_FOUND");
    return version;
  }
}

function templateFacts(
  parsed: z.infer<typeof templateImportSchema>,
  inspection: CoverTemplateInspection,
  assetId: string,
  checksum: string,
) {
  return coverTemplateFactsSchema.parse({
    assetId,
    checksum,
    pageWidthMm: inspection.pageWidthMm,
    pageHeightMm: inspection.pageHeightMm,
    backRegion: parsed.backRegion,
    spineRegion: parsed.spineRegion,
    frontRegion: parsed.frontRegion,
    toleranceMm: parsed.toleranceMm,
  });
}
