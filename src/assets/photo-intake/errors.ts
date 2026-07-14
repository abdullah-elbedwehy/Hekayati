import type { PhotoIntakeErrorCode } from "./types.js";

const publicMessages: Record<PhotoIntakeErrorCode, string> = {
  PHOTO_UNSUPPORTED_TYPE: "صيغة الصورة غير مدعومة. استخدم HEIC أو JPEG أو PNG.",
  PHOTO_DECODE_FAILED:
    "تعذر قراءة الصورة. اختر ملف صورة صالحًا وحاول مرة أخرى.",
  PHOTO_FILE_TOO_LARGE: "حجم ملف الصورة أكبر من الحد المسموح.",
  PHOTO_PIXEL_LIMIT_EXCEEDED: "أبعاد الصورة أكبر من الحد المسموح.",
  PHOTO_SUBJECT_SELECTION_REQUIRED:
    "حدّد الشخص المقصود داخل الصورة قبل المتابعة.",
};

export class PhotoIntakeError extends Error {
  readonly name = "PhotoIntakeError";
  readonly publicMessageAr: string;

  constructor(
    readonly code: PhotoIntakeErrorCode,
    readonly statusCode: 400 | 413 | 422 = statusFor(code),
  ) {
    super(code);
    this.publicMessageAr = publicMessages[code];
  }

  toSafeResponse(): { code: PhotoIntakeErrorCode; message: string } {
    return { code: this.code, message: this.publicMessageAr };
  }
}

export function normalizePhotoIntakeError(error: unknown): PhotoIntakeError {
  return error instanceof PhotoIntakeError
    ? error
    : new PhotoIntakeError("PHOTO_DECODE_FAILED");
}

function statusFor(code: PhotoIntakeErrorCode): 400 | 413 | 422 {
  if (code === "PHOTO_FILE_TOO_LARGE") return 413;
  if (
    code === "PHOTO_PIXEL_LIMIT_EXCEEDED" ||
    code === "PHOTO_SUBJECT_SELECTION_REQUIRED"
  )
    return 422;
  return 400;
}
