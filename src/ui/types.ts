export interface Settings {
  id: "operator";
  schemaVersion: 2;
  createdAt: string;
  updatedAt: string;
  textProvider: "mock" | "codex" | "gemini";
  imageProvider: "mock" | "codex" | "gemini";
  models: {
    codexText: string;
    geminiText: string;
    geminiImage: string;
    geminiImageEconomy: string;
  };
  concurrencyPerProvider: number;
  typography: { minimumAge3To5Pt: number; minimumAge6PlusPt: number };
  watermarkText: string;
  diskWarnGb: number;
  photoUploadMaxMb: number;
  photoMaxMegapixels: number;
  storagePathsReadonly: { data: string; assets: string };
  firstRunAcknowledged: boolean;
  deferredStatus: {
    providerLifecycle: "not_configured";
    printerProfiles: "not_configured";
  };
}

export type SettingsUpdate = Pick<
  Settings,
  | "textProvider"
  | "imageProvider"
  | "models"
  | "concurrencyPerProvider"
  | "typography"
  | "watermarkText"
  | "diskWarnGb"
  | "photoUploadMaxMb"
  | "photoMaxMegapixels"
  | "firstRunAcknowledged"
>;

export interface IntegrityReport {
  checked: number;
  healthy: number;
  issues: Array<{ assetId: string; reason: "missing" | "checksum_mismatch" }>;
  scannedAt: string;
}

export interface HealthSnapshot {
  checkedAt: string;
  database: { status: "ok" | "error" };
  disk: {
    status: "ok" | "warning" | "error";
    freeGb: number | null;
    thresholdGb: number;
  };
  integrity: IntegrityReport;
  listener: { status: "ok" | "error"; canonicalOrigin: string | null };
  providers: { status: "not_configured" };
  queue: { status: "not_available"; depth: null };
  printerProfiles: { status: "not_configured" };
}

export type LibraryStatus = "active" | "archived";
export type SourceMode = "photo" | "description" | "both";
export type RelationshipType =
  | "main_child"
  | "father"
  | "mother"
  | "brother"
  | "sister"
  | "grandfather"
  | "grandmother"
  | "friend"
  | "teacher"
  | "pet"
  | "custom";

export interface ConsentRecord {
  granted: boolean;
  date: string;
  note: string;
}

export interface LibraryCustomer {
  id: string;
  name: string;
  whatsapp: string;
  notes: string;
  consent: ConsentRecord | null;
  status: LibraryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryFamily {
  id: string;
  customerId: string;
  name: string;
  anchorCharacterId?: string;
  status: LibraryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterProfile {
  name: string;
  nickname: string;
  relationship: { type: RelationshipType; customLabel?: string };
  appearanceDescription: string;
  ageOrRange: string;
  gender: string;
  skinTone: string;
  hair: string;
  eyeColor: string;
  relativeHeight: string;
  build: string;
  distinguishingFeatures: string[];
  glasses: string;
  hijab: string;
  accessories: string[];
  interests: string[];
  favoriteObjects: string[];
  favoriteColor: string;
  personalityTraits: string[];
  speakingStyle: string;
  notes: string;
  sourceMode: SourceMode;
  referencePhotoIds: string[];
  traits: Record<string, string>;
}

export interface CharacterVersion {
  id: string;
  characterId: string;
  profile: CharacterProfile;
  createdAt: string;
}

export interface LibraryCharacter {
  id: string;
  familyId: string;
  status: LibraryStatus;
  currentVersionId: string;
  currentVersion: CharacterVersion;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LookVersion {
  id: string;
  lookId: string;
  name: string;
  clothing: string;
  appearanceOverrides: Record<string, string>;
  referencePhotoIds: string[];
  createdAt: string;
}

export interface LibraryLook {
  id: string;
  characterId: string;
  status: LibraryStatus;
  currentVersionId: string;
  currentVersion: LookVersion;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LibrarySnapshot {
  customers: LibraryCustomer[];
  families: LibraryFamily[];
  characters: LibraryCharacter[];
  looks: LibraryLook[];
  referencePhotos: LibraryReferencePhoto[];
}

export interface DuplicateCandidate {
  characterId: string;
  name: string;
  relationship: RelationshipType;
  thumbnailUrl?: string;
  reasons: Array<"normalized_name_relationship" | "exact_source_checksum">;
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

export interface PhotoWarning {
  code: PhotoWarningCode;
  source: "local_check" | "operator";
  metric?: string;
  threshold?: number;
  details?: string;
}

export interface SubjectRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PhotoIntakeReservation {
  reservationToken: string;
  thumbnailUrl: string;
  widthPx: number;
  heightPx: number;
  kind: "face" | "full_body" | "clothing" | "other";
  warnings: PhotoWarning[];
  duplicateCandidates: DuplicateCandidate[];
  peopleCount?: number;
  expiresAt: string;
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
  subjectBoxAreaRatio: number | null;
}

export interface PhotoQuality {
  policyVersion: string;
  metrics: PhotoQualityMetrics;
  warnings: PhotoWarning[];
  observations: PhotoObservations;
}

export interface LibraryReferencePhoto {
  id: string;
  characterId: string;
  lookId?: string;
  kind: "face" | "full_body" | "clothing" | "other";
  thumbnailUrl: string;
  widthPx: number;
  heightPx: number;
  quality: PhotoQuality;
  createdAt: string;
}
