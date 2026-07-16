export interface PrintRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PrintProfileDraft {
  trim: { widthMm: number; heightMm: number; orientation: "portrait" };
  bleedMm: number;
  safeContentRegion: PrintRegion;
  dpiMin: number;
  color:
    { mode: "rgb" } | { mode: "cmyk"; iccAssetId: string; iccChecksum: string };
  cropMarks: {
    enabled: boolean;
    offsetMm: number;
    lengthMm: number;
    strokePt: number;
  };
  spine:
    | { source: "missing"; widthMm: null }
    | { source: "explicit" | "template"; widthMm: number };
  coverTemplate: null | {
    assetId: string;
    checksum: string;
    pageWidthMm: number;
    pageHeightMm: number;
    backRegion: PrintRegion;
    spineRegion: PrintRegion;
    frontRegion: PrintRegion;
    toleranceMm: number;
  };
  requiredBlankPages: Array<{
    position: "before_interior" | "after_interior";
    count: number;
    label: string;
  }>;
}

export interface PrinterProfileProjection {
  profile: {
    id: string;
    revision: number;
    name: string;
    currentVersionId: string;
    archived: boolean;
  };
  version: PrintProfileDraft & {
    id: string;
    profileId: string;
    profileHash: string;
    readiness: "ready" | "incomplete";
    blockingReasons: string[];
  };
}

export interface PrintArtifactProjection {
  id: string;
  kind: "interior" | "cover";
  checksum: string;
  bytes: number;
  colorMode: "rgb" | "cmyk";
  renderFacts: {
    pageCount: number;
    minimumImagePpi: number | null;
    fontNames: string[];
    watermarkCount: 0;
    panelOrder: ["back", "spine", "front"] | null;
  };
}

export interface PrintRunProjection {
  id: string;
  revision: number;
  state:
    | "queued"
    | "producing"
    | "preflight_pending"
    | "converted_proof_pending"
    | "deliverable"
    | "blocked"
    | "stale"
    | "rejected";
  contentAuthorizationHash: string;
  approvalCycleId: string;
  approvalGateJobId: string;
  previewOutputId: string;
  compositionProfileId: string;
  printerProfileHash: string;
  printerProfileVersionId: string;
  currentInteriorArtifactId: string | null;
  currentCoverArtifactId: string | null;
  currentPreflightReportId: string | null;
  convertedProofBundleHash: string | null;
  blockingReasons: string[];
  staleReasons: string[];
}

export interface PrintPreflightProjection {
  id: string;
  passed: boolean;
  findings: Array<{
    code: string;
    artifact: "interior" | "cover" | "preview" | "bundle";
    page: number | null;
    expected: string | number | boolean;
    actual: string | number | boolean;
  }>;
  measurements: {
    colorMode: "rgb" | "cmyk";
    iccChecksum: string | null;
    outputIntentMatches: boolean;
    pageMap: Array<{
      outputPageNumber: number;
      kind: "customer" | "printer_blank";
      customerPageNumber: number | null;
      pageId: string | null;
      label: string | null;
    }>;
    interior: PdfFacts;
    cover: PdfFacts;
    sourceAssets: Array<{ role: string; assetId: string; checksum: string }>;
    outputChecksums: { interior: string; cover: string };
    coverSpread: {
      panelOrder: ["back", "spine", "front"];
      spineWidthMm: number;
      panels: Array<{
        kind: "back" | "spine" | "front";
        boxMm: PrintRegion;
      }>;
      foldLinesMm: [number, number];
    };
    cropMarks: {
      enabled: boolean;
      offsetMm: number;
      lengthMm: number;
      strokePt: number;
      interiorSegmentCount: number;
      coverSegmentCount: number;
    };
  };
  toolVersions: Record<string, string>;
}

interface PdfFacts {
  pageCount: number;
  minimumImagePpi: number | null;
  watermarkCount: number;
  fonts: Array<{
    name: string;
    embedded: boolean;
    subset: boolean;
    toUnicode: boolean;
  }>;
}

export interface PrintProjectProjection {
  project: {
    id: string;
    revision: number;
    status: string;
    compositionProfileId: string;
    currentContentApprovalId: string | null;
    printerProfileId: string | null;
  };
  profile: PrinterProfileProjection["profile"] | null;
  profileVersion: PrinterProfileProjection["version"] | null;
  compatibility:
    | { compatible: true }
    | {
        compatible: false;
        code: "COMPOSITION_PROFILE_MISMATCH";
        failedPredicates: string[];
      }
    | null;
  run: PrintRunProjection | null;
  interior: PrintArtifactProjection | null;
  cover: PrintArtifactProjection | null;
  report: PrintPreflightProjection | null;
  proof: null | {
    id: string;
    bundleHash: string;
    iccChecksum: string;
    contentAuthorizationHash: string;
    printerProfileHash: string;
  };
  proofGate: null | { id: string; revision: number; state: string };
  history: Array<{
    id: string;
    revision: number;
    state: PrintRunProjection["state"];
    createdAt: string;
    printerProfileHash: string;
    contentAuthorizationHash: string;
    staleReasons: string[];
    blockingReasons: string[];
  }>;
}
