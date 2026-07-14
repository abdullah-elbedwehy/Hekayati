import type { ReferencePhoto } from "../domain/library/index.js";

export interface SafeReferencePhotoView {
  id: string;
  characterId: string;
  lookId?: string;
  kind: ReferencePhoto["kind"];
  thumbnailUrl: string;
  widthPx: number;
  heightPx: number;
  quality: ReferencePhoto["quality"];
  createdAt: string;
}

/** Browser-safe projection: no original, working, crop, or provider asset IDs. */
export function toSafeReferencePhotoView(
  photo: ReferencePhoto,
): SafeReferencePhotoView {
  return {
    id: photo.id,
    characterId: photo.owner.characterId,
    ...(photo.owner.type === "look" ? { lookId: photo.owner.lookId } : {}),
    kind: photo.kind,
    thumbnailUrl: `/api/library/reference-photos/${photo.id}/thumbnail`,
    widthPx: photo.quality.metrics.widthPx,
    heightPx: photo.quality.metrics.heightPx,
    quality: photo.quality,
    createdAt: photo.createdAt,
  };
}
