import type { PreparedPhotoValue, StagedPhotoValue } from "./types.js";

type StageState = "active" | "released" | "transferred";

export class StagedPhoto {
  private state: StageState = "active";

  constructor(private readonly staged: StagedPhotoValue) {}

  get value(): StagedPhotoValue {
    if (this.state === "released") throw new Error("STAGED_PHOTO_RELEASED");
    if (this.state === "transferred")
      throw new Error("STAGED_PHOTO_TRANSFERRED");
    return this.staged;
  }

  transferOwnership(): StagedPhotoValue {
    const value = this.value;
    this.state = "transferred";
    return value;
  }

  cleanup(): void {
    if (this.state !== "active") return;
    wipeStaged(this.staged);
    this.state = "released";
  }
}

export class PreparedPhoto {
  private released = false;

  constructor(private readonly prepared: PreparedPhotoValue) {}

  get value(): PreparedPhotoValue {
    if (this.released) throw new Error("PREPARED_PHOTO_RELEASED");
    return this.prepared;
  }

  cleanup(): void {
    if (this.released) return;
    wipePrepared(this.prepared);
    this.released = true;
  }
}

export async function withPreparedPhoto<T>(
  prepared: PreparedPhoto,
  operation: (value: PreparedPhotoValue) => Promise<T>,
): Promise<T> {
  try {
    return await operation(prepared.value);
  } finally {
    prepared.cleanup();
  }
}

function wipePrepared(value: PreparedPhotoValue): void {
  wipeStaged(value);
  value.subjectCrop?.bytes.fill(0);
}

function wipeStaged(value: StagedPhotoValue): void {
  const buffers = new Set([
    value.original.bytes,
    value.working.bytes,
    value.thumbnail.bytes,
  ]);
  for (const buffer of buffers) buffer.fill(0);
}
