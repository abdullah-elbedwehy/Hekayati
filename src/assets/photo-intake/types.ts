export type PhotoIntakeErrorCode =
  | "PHOTO_UNSUPPORTED_TYPE"
  | "PHOTO_DECODE_FAILED"
  | "PHOTO_FILE_TOO_LARGE"
  | "PHOTO_PIXEL_LIMIT_EXCEEDED"
  | "PHOTO_SUBJECT_SELECTION_REQUIRED";

export type SupportedPhotoFormat = "jpeg" | "png" | "heic";
export type SupportedPhotoMime =
  "image/jpeg" | "image/png" | "image/heic" | "image/heif";

export interface DetectedPhotoType {
  format: SupportedPhotoFormat;
  mime: SupportedPhotoMime;
  extension: "jpg" | "png" | "heic" | "heif";
}

export type ReferencePhotoKind = "face" | "full_body" | "clothing" | "other";

export interface PhotoIntakeLimits {
  maxBytes: number;
  maxPixels: number;
}

export interface SubjectRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConfirmedSubjectSelection {
  rectangle: SubjectRectangle;
  confirmedByOperator: boolean;
}

export interface PixelCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PhotoObservations {
  peopleCount?: number;
  obstruction?: string;
  filterSuspected?: boolean;
  apparentAgeBand?: string;
  hair?: string;
  clothing?: string;
}

export interface PhotoQualityMetrics {
  widthPx: number;
  heightPx: number;
  blurScore: number;
  exposureScore: number;
  shadowFraction: number;
  subjectBoxAreaRatio?: number;
}

export type PhotoWarningCode =
  | "PHOTO_LIMITED_REFERENCES"
  | "PHOTO_BLURRY"
  | "PHOTO_FACE_TOO_SMALL"
  | "PHOTO_MULTIPLE_PEOPLE"
  | "PHOTO_EXTREME_SHADOWS"
  | "PHOTO_OBSTRUCTED"
  | "PHOTO_FILTER_SUSPECTED"
  | "PHOTO_AGE_CONFLICT"
  | "PHOTO_HAIR_CONFLICT"
  | "PHOTO_CLOTHING_CONFLICT";

export interface LocalPhotoWarning {
  code: PhotoWarningCode;
  source: "local_check";
  metric: string;
  threshold: number;
  value: number;
  comparison: "less_than" | "greater_than";
}

export interface OperatorPhotoWarning {
  code: PhotoWarningCode;
  source: "operator";
  observation:
    | "peopleCount"
    | "obstruction"
    | "filterSuspected"
    | "apparentAgeBand"
    | "hair"
    | "clothing";
  details: "recorded" | "conflict_with_existing_reference";
}

export type PhotoQualityWarning = LocalPhotoWarning | OperatorPhotoWarning;

export interface PhotoQualityReport {
  policyVersion: "PhotoQualityPolicy/v1";
  metrics: PhotoQualityMetrics;
  warnings: PhotoQualityWarning[];
  observations: PhotoObservations;
}

export interface SafePhotoDerivative {
  bytes: Buffer;
  mime: "image/jpeg";
  extension: "jpg";
  widthPx: number;
  heightPx: number;
  metadataStripped: true;
}

export interface LocalImageMetrics {
  blurScore: number;
  exposureScore: number;
  shadowFraction: number;
}

export interface ImageInspectionRequest {
  bytes: Buffer;
  detectedType: DetectedPhotoType;
  maxPixels?: number;
}

export interface ImageInspection {
  widthPx: number;
  heightPx: number;
}

export interface ImageDerivationRequest extends ImageInspectionRequest {
  maxPixels: number;
}

export interface PhotoBaseDerivativeSet {
  working: SafePhotoDerivative;
  thumbnail: SafePhotoDerivative;
  metrics: LocalImageMetrics;
}

export interface ImageSubjectCropRequest {
  working: SafePhotoDerivative;
  subjectSelection: SubjectRectangle;
}

export interface LocalPhotoImageAdapter {
  inspect(request: ImageInspectionRequest): Promise<ImageInspection>;
  deriveBase(request: ImageDerivationRequest): Promise<PhotoBaseDerivativeSet>;
  deriveSubjectCrop(
    request: ImageSubjectCropRequest,
  ): Promise<SafePhotoDerivative>;
}

export interface StagePhotoInput {
  source: AsyncIterable<Uint8Array>;
  limits: PhotoIntakeLimits;
  kind: ReferencePhotoKind;
}

export interface FinalizePhotoInput {
  subjectSelection?: ConfirmedSubjectSelection;
  observations?: PhotoObservations;
  existingObservations?: readonly PhotoObservations[];
  referenceCountAfterCommit?: number;
}

export type PreparePhotoInput = StagePhotoInput & FinalizePhotoInput;

export interface PreparedOriginalPhoto {
  bytes: Buffer;
  sha256: string;
  format: SupportedPhotoFormat;
  mime: SupportedPhotoMime;
  extension: "jpg" | "png" | "heic" | "heif";
}

export interface Dimensions {
  widthPx: number;
  heightPx: number;
}

export interface StagedPhotoValue {
  kind: ReferencePhotoKind;
  original: PreparedOriginalPhoto;
  working: SafePhotoDerivative;
  thumbnail: SafePhotoDerivative;
  workingDimensions: Dimensions;
  preliminaryQuality: PhotoQualityReport;
}

export interface PreparedPhotoValue extends StagedPhotoValue {
  subjectSelection?: SubjectRectangle;
  subjectCrop?: SafePhotoDerivative;
  providerDerivative: "working" | "subject_crop";
  providerDimensions: Dimensions;
  quality: PhotoQualityReport;
}

export interface PhotoQualityEvaluationInput {
  metrics: PhotoQualityMetrics;
  observations?: PhotoObservations;
  existingObservations?: readonly PhotoObservations[];
  referenceCountAfterCommit?: number;
}

export interface HeicConverter {
  convertToPng(bytes: Buffer, maxPixels?: number): Promise<Buffer>;
}
