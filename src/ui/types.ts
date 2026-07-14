export interface Settings {
  id: "operator";
  schemaVersion: 3;
  createdAt: string;
  updatedAt: string;
  textProvider: "mock" | "codex" | "gemini";
  imageProvider: "mock" | "codex" | "gemini";
  geminiImageTier: "default" | "economy";
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
    providerLifecycle: "available";
    printerProfiles: "not_configured";
  };
}

export type SettingsUpdate = Pick<
  Settings,
  | "textProvider"
  | "imageProvider"
  | "geminiImageTier"
  | "models"
  | "concurrencyPerProvider"
  | "typography"
  | "watermarkText"
  | "diskWarnGb"
  | "photoUploadMaxMb"
  | "photoMaxMegapixels"
  | "firstRunAcknowledged"
>;

export type ProviderId = "mock" | "codex" | "gemini";
export type IllustrationStyleId =
  "modern_cartoon" | "colorful_2d" | "soft_watercolor";

export interface ProviderProjection {
  state: "not_checked" | "available" | "unavailable";
  checkedAt: string | null;
  source: "fixture" | "cache" | "live" | null;
  authState: "ok" | "missing" | "expired" | "error" | null;
  text: {
    available: boolean;
    structured: boolean;
    modelId?: string;
    unavailableReason?: string;
  } | null;
  image: {
    available: boolean;
    modelId?: string;
    maxReferenceImages: number | null;
    reliableCharacterCount: number | null;
    economyTier: boolean;
    unavailableReason?: string;
  } | null;
  unavailableReason: string | null;
}

export interface GeminiCredentialStatus {
  present: boolean;
  masked: "••••••••" | null;
}

export interface ProviderStatusSnapshot {
  status: "available";
  checkedAt: string;
  selected: { text: ProviderId; image: ProviderId };
  models: Settings["models"];
  geminiImageTier: Settings["geminiImageTier"];
  credential: GeminiCredentialStatus;
  providers: Record<ProviderId, ProviderProjection>;
}

export interface ProviderTestResult {
  tested: ProviderId;
  provider: ProviderProjection;
}

export type PromptPolicyCheck =
  | { status: "allowed"; policyVersion: string }
  | {
      status: "confirmation_required";
      policyVersion: string;
      alternativePrompt: string;
      matchedCategories: Array<"franchise_trademark" | "living_artist">;
      bindingHash: string;
    };

export interface PromptPolicyConfirmation {
  policyVersion: string;
  bindingHash: string;
  confirmed: true;
}

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
  providers:
    | { status: "not_configured" }
    | {
        status: "available";
        selected: { text: ProviderId; image: ProviderId };
        connections: Record<ProviderId, ProviderProjection>;
      };
  queue: JobHealthSnapshot | { status: "not_available"; depth: null };
  printerProfiles: { status: "not_configured" };
}

export type JobState =
  | "created"
  | "blocked"
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "paused"
  | "canceled"
  | "waiting_review";

export type JobOperation = "text" | "structured" | "image";

export interface JobTarget {
  providerId: ProviderId;
  modelId: string;
  operation: JobOperation;
  settingsHash: string;
}

export interface SettingsTargetChangePreview {
  expectedSettingsUpdatedAt: string;
  impactHash: string;
  requiresConfirmation: boolean;
  targets: JobTarget[];
  affected: Array<{
    id: string;
    revision: number;
    state: JobState;
    projectId: string | null;
    standaloneScopeId: string | null;
    fromTarget: JobTarget;
    toTarget: JobTarget;
  }>;
}

export interface SettingsTargetChangeResult {
  settings: Settings;
  successorJobIds: string[];
}

export interface JobProgress {
  attempt: number;
  percent: number;
  noteCode: string;
  updatedAtMono: number;
  noProgress: boolean;
}

export interface JobFailure {
  category: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface JobProvenance {
  provider: ProviderId;
  modelId: string;
  at: string;
  inputVersionRefs: Record<string, string>;
  promptVersion: string;
  referenceAssetIds: string[];
  attempt: number;
  settingsSnapshotHash: string;
}

export interface JobEvent {
  id: string;
  createdAt: string;
  jobId: string;
  sequence: number;
  kind: string;
  attempt: number | null;
  fromState: JobState | null;
  toState: JobState | null;
  reason: string | null;
  noteCode: string | null;
}

export type QueueAction =
  "pause" | "resume" | "cancel" | "retry" | "priority" | "open_gate";

export interface QueueJobProjection {
  id: string;
  revision: number;
  jobType: string;
  projectId: string | null;
  standaloneScopeId: string | null;
  state: JobState;
  stateReason: string | null;
  priority: number;
  queuePosition: number | null;
  blockers: Array<{
    id: string;
    state: JobState;
    reason: string | null;
  }>;
  attempts: number;
  automaticRetries: number;
  manualRetries: number;
  progress: JobProgress | null;
  noProgress: boolean;
  target: JobTarget | null;
  createdAt: string;
  updatedAt: string;
  failure: JobFailure | null;
  provenance: JobProvenance | null;
  resultRefs: string[];
  gate: {
    gateKind: string;
    targetId: string;
    targetVersionId: string;
  } | null;
  allowedActions: QueueAction[];
  history: JobEvent[];
}

export interface QuotaIncident {
  id: string;
  revision: number;
  providerId: ProviderId;
  operation: JobOperation;
  status: "open" | "resolved";
  affectedScopeIds: string[];
  alternateTargets?: JobTarget[];
  resumeImpact: {
    impactHash: string;
    affectedCount: number;
  } | null;
  scopes: Array<{
    projectId: string | null;
    standaloneScopeId: string | null;
    impactHash: string;
    affectedCount: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialIncident {
  id: string;
  revision: number;
  providerId: ProviderId;
  status: "open" | "resolved";
  affectedScopeIds: string[];
  impactHash: string | null;
  affectedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StorageControl {
  active: boolean;
  reason: "disk_write_failure" | "insufficient_disk_space" | null;
  workerStatus: "stopped" | "running" | "halted";
  lastRecoveryAt: string | null;
  lastProbeAt: string | null;
  lastProbeStatus: "failed" | "succeeded" | null;
  resumeImpact: {
    expectedRevision: number;
    impactHash: string;
    affectedCount: number;
  } | null;
}

export interface QueueProjection {
  checkedAt: string;
  jobs: QueueJobProjection[];
  counts: Record<JobState, number>;
  stalledCount: number;
  runningByProvider: Record<string, number>;
  quotaIncidents: QuotaIncident[];
  credentialIncidents: CredentialIncident[];
  projectActions: Array<{
    projectId: string;
    pause: { impactHash: string; affectedCount: number };
    resume: { impactHash: string; affectedCount: number };
  }>;
  storage: StorageControl;
}

export interface JobHealthSnapshot {
  status: "available";
  workerStatus: "stopped" | "running" | "halted";
  depth: number;
  counts: Record<JobState, number>;
  runningByProvider: Record<string, number>;
  stalledCount: number;
  storage: {
    active: boolean;
    reason: StorageControl["reason"];
  };
  openQuotaIncidents: number;
  openCredentialIncidents: number;
  lastRecoveryAt: string | null;
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

export type AuthoringPageCount = 16 | 24;

export interface AuthoringParticipantInput {
  characterId: string;
  narrativeRole: string;
  appearance?: { type: "base" } | { type: "shared_look"; lookId: string };
}

export interface AuthoringProjectInput {
  title: string;
  mainChildId: string;
  participants: AuthoringParticipantInput[];
  occasion: string;
  dedicationText: string;
  storyType:
    | "connected_adventure"
    | "related_situations"
    | "saved_template"
    | "fully_custom";
  templateId?: string | null;
  templateSeedKey?: string | null;
  pageCount: AuthoringPageCount;
  tone:
    | "light_funny"
    | "adventurous"
    | "warm_family"
    | "magical"
    | "educational_non_preachy"
    | "custom";
  customTone: string | null;
  illustrationStyleId: "modern_cartoon" | "colorful_2d" | "soft_watercolor";
  hiddenGoal: {
    goal:
      | "confidence"
      | "enjoying_school"
      | "reducing_phone_use"
      | "sharing"
      | "courage"
      | "welcoming_sibling"
      | "responsibility"
      | "cooperation"
      | "custom";
    customGoal: string | null;
    presentation: "indirect" | "acknowledged_ending";
  } | null;
  clothingNotes: string;
  customNotes: string;
  audienceAgeBand: "age_3_5" | "age_6_8" | "age_9_12";
  readingLevel: "early" | "developing" | "independent";
  sceneComplexity: "low" | "medium" | "high";
  selectedNarrationPercent: number | null;
  customStory: {
    premise: string;
    beginningBeat: string;
    middleBeat: string;
    endingBeat: string;
    contentBoundaries: string[];
  } | null;
  endingPages: { farewellText: string; brandLine: string };
}

export interface AuthoringMentionProps {
  action: string;
  emotion: string;
  position: string | null;
  framing: string | null;
  lookId: string | null;
  heldObject: string | null;
  gazeTarget: string | null;
  speaks: boolean;
  dialogue: string | null;
}

export type AuthoringSegment =
  | { type: "text"; text: string }
  | { type: "mention"; characterId: string; props: AuthoringMentionProps }
  | {
      type: "group";
      groupKey: "hero" | "friends" | "family";
      props?: AuthoringMentionProps;
    }
  | { type: "unresolved"; text: string };

export interface AuthoringSceneContent {
  purpose: string;
  description: string;
  documentSegments: AuthoringSegment[];
  environment: string;
  timeOfDay: string;
  composition: string;
  cameraFraming: string;
  narrativeText: string;
  dialogue: Array<{ speakerCharacterId: string; text: string }>;
  twoImageMoment: boolean;
}

export interface AuthoringProjectWorkspace {
  project: {
    id: string;
    customerId: string;
    familyId: string;
    status: string;
    currentVersionId: string;
  };
  version: {
    id: string;
    storyConfig: Omit<AuthoringProjectInput, "participants"> & {
      templateVersionId: string | null;
      narrationDialogueBalance: {
        suggestedNarrationPercent: number;
        selectedNarrationPercent: number;
        operatorEdited: boolean;
        formulaVersion: "hekayati.balance.v1";
      };
      participants: Array<
        Omit<AuthoringParticipantInput, "appearance"> & {
          characterVersionId: string;
          appearance:
            | { type: "base" }
            | {
                type: "shared_look";
                lookId: string;
                lookVersionId: string;
              }
            | {
                type: "project_override";
                overrideId: string;
                overrideVersionId: string;
              };
        }
      >;
    };
  };
  story: { id: string; status: "draft" | "complete"; currentVersionId: string };
  storyVersion: { id: string; sceneVersionIds: string[] };
  scenes: Array<{
    scene: { id: string; storyPageIndex: number };
    version: {
      id: string;
      needsAuthoring: boolean;
      content: AuthoringSceneContent;
    };
  }>;
  pageMap: Array<{
    pageNumber: number;
    kind: "title" | "dedication" | "story" | "farewell" | "brand";
    storyPageIndex?: number;
  }>;
}

export interface AuthoringOverrideResult {
  projectVersion: { id: string };
  override: { id: string; currentVersionId: string };
  overrideVersion: { id: string };
  event: { id: string; matrixRow: "IM-04" };
}

export interface AuthoringTemplateRecord {
  id: string;
  status: "active" | "archived" | "disabled";
  template: {
    id: string;
    seedKey: string | null;
    status: "active" | "archived" | "disabled";
    currentVersionId: string;
  };
  version: {
    id: string;
    content: AuthoringTemplateContent;
  };
}

export interface AuthoringTemplateContent {
  name: string;
  premise: string;
  structure: Array<{ key: string; purpose: string }>;
  environments: string[];
  roleSlots: Array<{
    slot: string;
    label: string;
    required: boolean;
    requiredRelationship: RelationshipType | null;
    narrativeRole: string;
  }>;
  variables: Array<{
    key: string;
    label: string;
    type: "text" | "long_text" | "text_list";
    required: boolean;
    defaultValue: string | string[] | null;
  }>;
  possibleHiddenGoals: string[];
  sceneGuidance: string[];
  ageAdaptationRules: Array<{
    ageBand: AuthoringProjectInput["audienceAgeBand"];
    guidance: string;
  }>;
  contentBoundaries: string[];
  endingPatterns: string[];
}

export interface MentionCandidate {
  characterId: string;
  displayName: string;
  relationshipType: RelationshipType;
  narrativeRole: string;
  thumbnailUrl: string | null;
  archived: boolean;
}

export interface PageCountPlan {
  input: {
    projectId: string;
    expectedProjectVersionId: string;
    expectedStoryVersionId: string;
    from: AuthoringPageCount;
    to: AuthoringPageCount;
    sourceSceneVersionIds: string[];
  };
  operations: Array<{
    type: "retain" | "add" | "merge" | "remove";
    targetStoryPageIndex: number | null;
    sourceSceneVersionIds: string[];
  }>;
  hash: string;
}
