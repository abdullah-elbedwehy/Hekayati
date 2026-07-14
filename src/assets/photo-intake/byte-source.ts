import { PhotoIntakeError, normalizePhotoIntakeError } from "./errors.js";

export async function readBoundedPhoto(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  assertByteLimit(maxBytes);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array))
        throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
      total += chunk.byteLength;
      if (total > maxBytes) throw new PhotoIntakeError("PHOTO_FILE_TOO_LARGE");
      chunks.push(Buffer.from(chunk));
    }
    const result = Buffer.concat(chunks, total);
    wipe(chunks);
    return result;
  } catch (error) {
    wipe(chunks);
    throw normalizePhotoIntakeError(error);
  }
}

function assertByteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("INVALID_PHOTO_BYTE_LIMIT");
}

function wipe(chunks: readonly Buffer[]): void {
  for (const chunk of chunks) chunk.fill(0);
}
