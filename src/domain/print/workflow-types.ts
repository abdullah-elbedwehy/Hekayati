import { z } from "zod";

import type { PreparedAsset } from "../../assets/asset-store.js";
import type { JobRecord } from "../../jobs/schemas.js";
import type { ApprovedBookSnapshot } from "../layout/approvals.js";
import type {
  CoverCompositionVersion,
  PreviewOutput,
} from "../layout/schemas.js";
import type {
  PrinterProfile,
  PrinterProfileVersion,
  PrintArtifact,
  PrintPreflightReport,
  PrintProofBundle,
  PrintRun,
} from "./schemas.js";

const entityIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const printStartInputSchema = z
  .object({
    owner: z
      .object({ customerId: entityIdSchema, familyId: entityIdSchema })
      .strict(),
    projectId: entityIdSchema,
    expectedProjectRevision: z.number().int().nonnegative(),
    profileId: entityIdSchema,
    expectedProfileRevision: z.number().int().nonnegative(),
    profileVersionId: entityIdSchema,
    contentAuthorizationHash: hashSchema,
    idempotencyKey: z.string().trim().min(1).max(160),
  })
  .strict();

export type ParsedPrintStartInput = z.infer<typeof printStartInputSchema>;

export interface PrintStartInput {
  owner: { customerId: string; familyId: string };
  projectId: string;
  expectedProjectRevision: number;
  profileId: string;
  expectedProfileRevision: number;
  profileVersionId: string;
  contentAuthorizationHash: string;
  idempotencyKey: string;
}

export interface PrintStartResult {
  run: PrintRun;
  jobs: [JobRecord, JobRecord];
  replayed: boolean;
}

export interface PrintProductionOptions {
  now?: () => string;
  idFactory?: () => string;
}

export interface PreparedPrintArtifactCommit {
  kind: "interior" | "cover";
  runId: string;
  preparedAsset: PreparedAsset;
  contentAuthorizationHash: string;
  printerProfileVersionId: string;
  printerProfileHash: string;
  sourceSnapshotHash: string;
  pageMapHash: string;
  colorMode: "rgb" | "cmyk";
  iccChecksum: string | null;
  rendererVersion: string;
  converterVersion: string | null;
  fontPolicyVersion: string;
  renderFactsHash: string;
  renderFacts: PrintArtifact["renderFacts"];
  conversionFacts: PrintArtifact["conversionFacts"];
}

export interface PrintArtifactCommitResult {
  artifact: PrintArtifact;
  run: PrintRun;
  preflightJob: JobRecord | null;
}

export interface PreparedPrintPreflightCommit {
  runId: string;
  report: PrintPreflightReport;
  proof: null | {
    bundleId: string;
    gateId: string;
    rasters: [
      { kind: "interior"; prepared: PreparedAsset },
      { kind: "cover"; prepared: PreparedAsset },
    ];
  };
}

export interface PrintPreflightCommitResult {
  run: PrintRun;
  report: PrintPreflightReport;
  proofBundle: PrintProofBundle | null;
  proofGate: JobRecord | null;
}

export interface MaterializationContext {
  snapshot: ApprovedBookSnapshot;
  output: PreviewOutput;
  cover: CoverCompositionVersion;
  profile: PrinterProfile;
  profileVersion: PrinterProfileVersion;
  compositionProfileHash: string;
  sourceAssets: Array<{ role: string; assetId: string; checksum: string }>;
  sourceSnapshotHash: string;
}
