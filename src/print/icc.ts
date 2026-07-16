import { createHash } from "node:crypto";

export const MAX_ICC_PROFILE_BYTES = 8 * 1024 * 1024;

export type IccColorSpace = "CMYK" | "RGB";

export interface IccProfileFacts {
  bytes: number;
  declaredBytes: number;
  dataColorSpace: IccColorSpace;
  channels: 3 | 4;
  profileClass: "display" | "output";
  profileConnectionSpace: "Lab" | "XYZ";
  tagCount: number;
  checksum: string;
  signature: "acsp";
}

export class IccInspectionError extends Error {
  readonly name = "IccInspectionError";
  constructor(readonly code: IccInspectionErrorCode) {
    super(code);
  }
}

export type IccInspectionErrorCode =
  | "ICC_SIZE_INVALID"
  | "ICC_LENGTH_MISMATCH"
  | "ICC_SIGNATURE_INVALID"
  | "ICC_COLOR_SPACE_UNSUPPORTED"
  | "ICC_STRUCTURE_INVALID"
  | "ICC_REQUIRED_TAG_MISSING";

export function inspectIccProfile(bytes: Buffer): IccProfileFacts {
  if (bytes.length < 132 || bytes.length > MAX_ICC_PROFILE_BYTES)
    fail("ICC_SIZE_INVALID");
  const declaredBytes = bytes.readUInt32BE(0);
  if (declaredBytes !== bytes.length) fail("ICC_LENGTH_MISMATCH");
  if (bytes.toString("ascii", 36, 40) !== "acsp") fail("ICC_SIGNATURE_INVALID");
  const profileClass = classSignature(bytes.toString("ascii", 12, 16));
  const rawColorSpace = bytes.toString("ascii", 16, 20);
  const color = colorSpace(rawColorSpace);
  const profileConnectionSpace = pcsSignature(bytes.toString("ascii", 20, 24));
  validateHeader(bytes);
  const tagCount = bytes.readUInt32BE(128);
  const tags = parseTagTable(bytes, tagCount);
  validateRequiredTags(tags, color.dataColorSpace, profileClass);
  return {
    bytes: bytes.length,
    declaredBytes,
    dataColorSpace: color.dataColorSpace,
    channels: color.channels,
    profileClass,
    profileConnectionSpace,
    tagCount,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    signature: "acsp",
  };
}

export function requireCmykIccProfile(bytes: Buffer): IccProfileFacts {
  const facts = inspectIccProfile(bytes);
  if (facts.channels !== 4 || facts.profileClass !== "output")
    fail("ICC_COLOR_SPACE_UNSUPPORTED");
  return facts;
}

interface IccTag {
  signature: string;
  type: string;
}

function validateHeader(bytes: Buffer): void {
  const majorVersion = bytes[8];
  if (majorVersion !== 2 && majorVersion !== 4) fail("ICC_STRUCTURE_INVALID");
  const date = Array.from({ length: 6 }, (_, index) =>
    bytes.readUInt16BE(24 + index * 2),
  );
  const [year, month, day, hour, minute, second] = date;
  if (
    !year ||
    year < 1900 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    bytes.readUInt32BE(64) > 3 ||
    bytes.readInt32BE(72) <= 0
  )
    fail("ICC_STRUCTURE_INVALID");
}

function parseTagTable(bytes: Buffer, tagCount: number): IccTag[] {
  if (tagCount < 1 || tagCount > 4096) fail("ICC_STRUCTURE_INVALID");
  const tableEnd = 132 + tagCount * 12;
  if (!Number.isSafeInteger(tableEnd) || tableEnd > bytes.length)
    fail("ICC_LENGTH_MISMATCH");
  const signatures = new Set<string>();
  const tags: IccTag[] = [];
  for (let index = 0; index < tagCount; index += 1) {
    const row = 132 + index * 12;
    const signature = bytes.toString("ascii", row, row + 4);
    const offset = bytes.readUInt32BE(row + 4);
    const size = bytes.readUInt32BE(row + 8);
    const end = offset + size;
    if (
      !printableSignature(signature) ||
      signatures.has(signature) ||
      offset < tableEnd ||
      offset % 4 !== 0 ||
      size < 8 ||
      !Number.isSafeInteger(end) ||
      end > bytes.length
    )
      fail("ICC_STRUCTURE_INVALID");
    const type = bytes.toString("ascii", offset, offset + 4);
    if (!printableSignature(type) || bytes.readUInt32BE(offset + 4) !== 0)
      fail("ICC_STRUCTURE_INVALID");
    signatures.add(signature);
    tags.push({ signature, type });
  }
  return tags;
}

function validateRequiredTags(
  tags: IccTag[],
  color: IccColorSpace,
  profileClass: IccProfileFacts["profileClass"],
): void {
  const bySignature = new Map(tags.map((tag) => [tag.signature, tag]));
  const hasDescription = bySignature.has("desc") || bySignature.has("mluc");
  if (!hasDescription || !bySignature.has("cprt") || !bySignature.has("wtpt"))
    fail("ICC_REQUIRED_TAG_MISSING");
  if (color === "CMYK" || profileClass === "output") {
    const forward = bySignature.get("A2B0");
    const reverse = bySignature.get("B2A0");
    if (
      !forward ||
      !reverse ||
      !["mft1", "mft2", "mAB "].includes(forward.type) ||
      !["mft1", "mft2", "mBA "].includes(reverse.type)
    )
      fail("ICC_REQUIRED_TAG_MISSING");
    return;
  }
  const matrixTags = ["rXYZ", "gXYZ", "bXYZ", "rTRC", "gTRC", "bTRC"];
  if (
    !bySignature.has("A2B0") &&
    !matrixTags.every((tag) => bySignature.has(tag))
  )
    fail("ICC_REQUIRED_TAG_MISSING");
}

function classSignature(value: string): IccProfileFacts["profileClass"] {
  if (value === "mntr") return "display";
  if (value === "prtr") return "output";
  return fail("ICC_COLOR_SPACE_UNSUPPORTED");
}

function pcsSignature(
  value: string,
): IccProfileFacts["profileConnectionSpace"] {
  if (value === "XYZ ") return "XYZ";
  if (value === "Lab ") return "Lab";
  return fail("ICC_STRUCTURE_INVALID");
}

function printableSignature(value: string): boolean {
  return /^[\x20-\x7e]{4}$/u.test(value);
}

function colorSpace(value: string): {
  dataColorSpace: IccColorSpace;
  channels: 3 | 4;
} {
  if (value === "CMYK") return { dataColorSpace: "CMYK", channels: 4 };
  if (value === "RGB ") return { dataColorSpace: "RGB", channels: 3 };
  return fail("ICC_COLOR_SPACE_UNSUPPORTED");
}

function fail(code: IccInspectionErrorCode): never {
  throw new IccInspectionError(code);
}
