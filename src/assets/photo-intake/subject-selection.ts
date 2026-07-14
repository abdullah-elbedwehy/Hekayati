import { PhotoIntakeError } from "./errors.js";
import type {
  ConfirmedSubjectSelection,
  PixelCrop,
  ReferencePhotoKind,
  SubjectRectangle,
} from "./types.js";

export function validateSubjectSelection(
  kind: ReferencePhotoKind,
  selection?: ConfirmedSubjectSelection,
): SubjectRectangle | undefined {
  if (!selection) {
    if (kind === "face")
      throw new PhotoIntakeError("PHOTO_SUBJECT_SELECTION_REQUIRED");
    return undefined;
  }
  if (!selection?.confirmedByOperator || !isValidRectangle(selection.rectangle))
    throw new PhotoIntakeError("PHOTO_SUBJECT_SELECTION_REQUIRED");
  return { ...selection.rectangle };
}

export function toPixelCrop(
  rectangle: SubjectRectangle,
  imageWidth: number,
  imageHeight: number,
): PixelCrop {
  if (!isValidRectangle(rectangle) || !isDimension(imageWidth, imageHeight))
    throw new PhotoIntakeError("PHOTO_SUBJECT_SELECTION_REQUIRED");
  const left = Math.floor(rectangle.x * imageWidth);
  const top = Math.floor(rectangle.y * imageHeight);
  const right = Math.min(
    imageWidth,
    Math.ceil((rectangle.x + rectangle.width) * imageWidth),
  );
  const bottom = Math.min(
    imageHeight,
    Math.ceil((rectangle.y + rectangle.height) * imageHeight),
  );
  if (right <= left || bottom <= top)
    throw new PhotoIntakeError("PHOTO_SUBJECT_SELECTION_REQUIRED");
  return { left, top, width: right - left, height: bottom - top };
}

function isValidRectangle(rectangle: SubjectRectangle): boolean {
  const values = [rectangle.x, rectangle.y, rectangle.width, rectangle.height];
  return (
    values.every(Number.isFinite) &&
    rectangle.x >= 0 &&
    rectangle.y >= 0 &&
    rectangle.width > 0 &&
    rectangle.height > 0 &&
    rectangle.x + rectangle.width <= 1 &&
    rectangle.y + rectangle.height <= 1
  );
}

function isDimension(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    width > 0 &&
    Number.isSafeInteger(height) &&
    height > 0
  );
}
