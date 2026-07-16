import { readFileSync } from "node:fs";

const PROFILE_ROOT = "/System/Library/ColorSync/Profiles";

const PROFILE_PATHS = {
  CMYK: `${PROFILE_ROOT}/Generic CMYK Profile.icc`,
  "RGB ": `${PROFILE_ROOT}/sRGB Profile.icc`,
} as const;

export function validTestIcc(colorSpace: keyof typeof PROFILE_PATHS): Buffer {
  return Buffer.from(readFileSync(PROFILE_PATHS[colorSpace]));
}

export function paddedTestIcc(
  colorSpace: keyof typeof PROFILE_PATHS,
  length: number,
): Buffer {
  const source = validTestIcc(colorSpace);
  if (length < source.length)
    throw new Error("TEST_ICC_TARGET_LENGTH_TOO_SMALL");
  const bytes = Buffer.alloc(length);
  source.copy(bytes);
  bytes.writeUInt32BE(length, 0);
  return bytes;
}
