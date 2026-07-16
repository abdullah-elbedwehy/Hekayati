import type {
  CoverGeometry,
  InteriorGeometry,
  OutputPageMapEntry,
} from "../domain/print/geometry.js";
import type { PrinterProfileVersion } from "../domain/print/schemas.js";

export interface PrintDocumentImage {
  bytes: Buffer;
  mime: "image/png" | "image/jpeg";
  widthPx: number;
  heightPx: number;
  assetId: string;
  checksum: string;
  effectivePpi: number;
}

export interface PrintTextContent {
  text: string;
  region: { x: number; y: number; width: number; height: number };
  fontSizePt: number;
  style: "heading" | "body";
  aid: "none" | "gradient" | "panel";
}

export interface PrintBubbleContent {
  speakerLabel: string;
  text: string;
  region: { x: number; y: number; width: number; height: number };
}

export interface PrintInteriorPageContent {
  map: OutputPageMapEntry;
  pageKind:
    "title" | "dedication" | "story" | "ending1" | "ending2" | "printer_blank";
  image: PrintDocumentImage | null;
  text: PrintTextContent | null;
  bubbles: PrintBubbleContent[];
}

export interface PrintInteriorDocument {
  kind: "interior";
  profile: PrinterProfileVersion;
  geometry: InteriorGeometry;
  sourceSnapshotHash: string;
  fontManifestHash: string;
  pages: PrintInteriorPageContent[];
}

export interface PrintCoverPanelContent {
  kind: "back" | "spine" | "front";
  image: PrintDocumentImage | null;
  text: PrintTextContent | null;
}

export interface PrintCoverDocument {
  kind: "cover";
  profile: PrinterProfileVersion;
  geometry: CoverGeometry;
  sourceSnapshotHash: string;
  fontManifestHash: string;
  panels: [
    PrintCoverPanelContent,
    PrintCoverPanelContent,
    PrintCoverPanelContent,
  ];
}
