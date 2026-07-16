import type {
  CharacterProfile,
  CharacterVersion,
  ConsentRecord,
  HealthSnapshot,
  IntegrityReport,
  LibraryCharacter,
  LibraryCustomer,
  LibraryFamily,
  LibraryLook,
  LibraryReferencePhoto,
  LibrarySnapshot,
  LookVersion,
  PhotoIntakeReservation,
  PhotoObservations,
  Settings,
  SettingsUpdate,
  SettingsTargetChangePreview,
  SettingsTargetChangeResult,
  SubjectRectangle,
  AuthoringPageCount,
  AuthoringOverrideResult,
  AuthoringProjectInput,
  AuthoringProjectWorkspace,
  AuthoringSceneContent,
  AuthoringTemplateRecord,
  AuthoringTemplateContent,
  MentionCandidate,
  PageCountPlan,
  GeminiCredentialStatus,
  PromptPolicyCheck,
  PromptPolicyConfirmation,
  ProviderId,
  ProviderStatusSnapshot,
  ProviderTestResult,
  IllustrationStyleId,
  JobState,
  JobTarget,
  QueueJobProjection,
  QueueProjection,
} from "./types";
import { PrintApiClient } from "./print-api-client";
import { ApiError } from "./api-error";

export { ApiError } from "./api-error";

interface BootstrapResponse {
  appName: string;
  direction: "rtl";
  canonicalOrigin: string;
  csrfToken: string;
}

export interface CustomerInput {
  name: string;
  whatsapp: string;
  notes: string;
}

export interface FamilyInput {
  name: string;
}

export interface CharacterInput {
  profile: CharacterProfile;
  preflightToken: string;
  duplicateDecision?: { action: "create_separate" };
}

export interface CharacterPreflightResult {
  preflightToken: string;
  expiresAt: string;
  duplicateCandidates: Array<{
    characterId: string;
    currentVersionId: string;
    name: string;
    relationship: CharacterProfile["relationship"];
    reasons: Array<"normalized_name_relationship" | "source_checksum">;
  }>;
}

export interface CharacterVersionInput {
  expectedVersionId: string;
  intent: "update_base";
  profile: CharacterProfile;
}

export interface LookInput {
  name: string;
  clothing: string;
  appearanceOverrides: Record<string, string>;
  referencePhotoIds: string[];
}

export interface LookVersionInput extends LookInput {
  expectedVersionId: string;
}

export interface PhotoStageInput {
  file: File;
  familyId: string;
  kind: "face" | "full_body" | "clothing" | "other";
  owner:
    | { type: "character"; characterId: string }
    | { type: "look"; characterId: string; lookId: string }
    | { type: "new_character"; draft: CharacterProfile };
}

export interface PhotoCommitInput {
  reservationToken: string;
  subjectSelection?: SubjectRectangle;
  subjectSelectionConfirmed?: boolean;
  intendedPersonConfirmed?: boolean;
  observations: PhotoObservations;
  duplicateDecision:
    | { action: "create_separate" }
    | { action: "open_existing"; characterId: string };
}

export interface PhotoCommitResult {
  action: "attached" | "opened_existing";
  characterId: string;
  referencePhotoId?: string;
  referencePhoto?: LibraryReferencePhoto;
}

export class ApiClient extends PrintApiClient {
  private constructor(csrfToken: string) {
    super(csrfToken);
  }

  static async connect(): Promise<ApiClient> {
    const response = await fetch("/api/bootstrap", { cache: "no-store" });
    if (!response.ok) throw new ApiError("request_failed");
    const bootstrap = (await response.json()) as BootstrapResponse;
    if (bootstrap.canonicalOrigin !== window.location.origin)
      throw new ApiError("request_failed");
    return new ApiClient(bootstrap.csrfToken);
  }

  settings(): Promise<Settings> {
    return this.request("/api/settings");
  }

  updateSettings(update: SettingsUpdate): Promise<Settings> {
    return this.request("/api/settings", {
      method: "PUT",
      body: JSON.stringify(update),
    });
  }

  previewSettingsTargetChange(
    update: SettingsUpdate,
  ): Promise<SettingsTargetChangePreview> {
    return this.json("/api/settings/target-change/preview", "POST", update);
  }

  confirmSettingsTargetChange(input: {
    update: SettingsUpdate;
    expectedSettingsUpdatedAt: string;
    impactHash: string;
  }): Promise<SettingsTargetChangeResult> {
    return this.json("/api/settings/target-change/confirm", "POST", input);
  }

  providerStatus(): Promise<ProviderStatusSnapshot> {
    return this.request("/api/providers/status");
  }

  testProvider(providerId: ProviderId): Promise<ProviderTestResult> {
    return this.json(`/api/providers/${providerId}/test`, "POST", {});
  }

  geminiCredential(): Promise<GeminiCredentialStatus> {
    return this.request("/api/providers/gemini/credential");
  }

  saveGeminiCredential(key: string): Promise<GeminiCredentialStatus> {
    return this.json("/api/providers/gemini/credential", "PUT", { key });
  }

  deleteGeminiCredential(): Promise<GeminiCredentialStatus> {
    return this.json("/api/providers/gemini/credential", "DELETE", {});
  }

  checkPromptPolicy(
    prompt: string,
    styleId: IllustrationStyleId,
  ): Promise<PromptPolicyCheck> {
    return this.json("/api/providers/prompt-policy/check", "POST", {
      prompt,
      styleId,
    });
  }

  confirmPromptPolicy(input: {
    prompt: string;
    styleId: IllustrationStyleId;
    bindingHash: string;
  }): Promise<PromptPolicyConfirmation> {
    return this.json("/api/providers/prompt-policy/confirm", "POST", input);
  }

  health(): Promise<HealthSnapshot> {
    return this.request("/api/health");
  }

  jobs(): Promise<QueueProjection> {
    return this.request("/api/jobs");
  }

  job(id: string): Promise<QueueJobProjection> {
    return this.request(`/api/jobs/${encodeURIComponent(id)}`);
  }

  jobAction(
    id: string,
    action: "pause" | "resume" | "cancel" | "retry",
    expected: { expectedRevision: number; expectedState: JobState },
  ): Promise<QueueJobProjection> {
    return this.json(
      `/api/jobs/${encodeURIComponent(id)}/${action}`,
      "POST",
      expected,
    );
  }

  setJobPriority(
    id: string,
    input: {
      expectedRevision: number;
      expectedState: JobState;
      priority: number;
    },
  ): Promise<QueueJobProjection> {
    return this.json(
      `/api/jobs/${encodeURIComponent(id)}/priority`,
      "PUT",
      input,
    );
  }

  pauseProjectJobs(
    projectId: string,
    impactHash: string,
  ): Promise<{ affectedJobIds: string[] }> {
    return this.json(
      `/api/jobs/projects/${encodeURIComponent(projectId)}/pause`,
      "POST",
      { impactHash },
    );
  }

  resumeProjectJobs(
    projectId: string,
    impactHash: string,
  ): Promise<{ affectedJobIds: string[] }> {
    return this.json(
      `/api/jobs/projects/${encodeURIComponent(projectId)}/resume`,
      "POST",
      { impactHash },
    );
  }

  decideQuota(input: {
    incidentId: string;
    actionId: string;
    expectedRevision: number;
    impactHash: string;
    projectId: string | null;
    standaloneScopeId: string | null;
    decision: "wait" | "continue";
    alternateTarget?: JobTarget;
  }): Promise<{ successorJobIds: string[] }> {
    const { incidentId, ...body } = input;
    return this.json(
      `/api/jobs/quota/${encodeURIComponent(incidentId)}/decision`,
      "POST",
      body,
    );
  }

  resumeQuota(
    incidentId: string,
    input: {
      actionId: string;
      expectedRevision: number;
      impactHash: string;
      confirmedAffectedCount: number;
    },
  ) {
    return this.json<{ affectedJobIds: string[] }>(
      `/api/jobs/quota/${encodeURIComponent(incidentId)}/resume`,
      "POST",
      input,
    );
  }

  resumeCredentials(
    incidentId: string,
    expectedRevision: number,
    impactHash: string,
  ) {
    return this.json<{ affectedJobIds: string[] }>(
      `/api/jobs/credentials/${encodeURIComponent(incidentId)}/resume`,
      "POST",
      { expectedRevision, impactHash },
    );
  }

  resumeJobStorage(input: {
    expectedRevision: number;
    impactHash: string;
    confirmedAffectedCount: number;
    confirmed: true;
  }): Promise<{ affectedJobIds: string[] }> {
    return this.json("/api/jobs/storage/resume", "POST", input);
  }

  scanIntegrity(): Promise<IntegrityReport> {
    return this.request("/api/health/integrity-scan", { method: "POST" });
  }

  library(): Promise<LibrarySnapshot> {
    return this.request("/api/library");
  }

  createCustomer(input: CustomerInput): Promise<LibraryCustomer> {
    return this.json("/api/library/customers", "POST", input);
  }

  updateCustomer(id: string, input: CustomerInput): Promise<LibraryCustomer> {
    return this.json(`/api/library/customers/${id}`, "PATCH", input);
  }

  setCustomerVisibility(
    id: string,
    action: "archive" | "restore",
  ): Promise<LibraryCustomer> {
    return this.json(`/api/library/customers/${id}/${action}`, "POST", {});
  }

  recordConsent(
    id: string,
    consent: ConsentRecord | null,
  ): Promise<LibraryCustomer> {
    return this.json(`/api/library/customers/${id}/consent`, "POST", {
      consent,
    });
  }

  createFamily(customerId: string, input: FamilyInput): Promise<LibraryFamily> {
    return this.json(
      `/api/library/customers/${customerId}/families`,
      "POST",
      input,
    );
  }

  updateFamily(id: string, input: FamilyInput): Promise<LibraryFamily> {
    return this.json(`/api/library/families/${id}`, "PATCH", input);
  }

  setFamilyVisibility(
    id: string,
    action: "archive" | "restore",
  ): Promise<LibraryFamily> {
    return this.json(`/api/library/families/${id}/${action}`, "POST", {});
  }

  createCharacter(
    familyId: string,
    input: CharacterInput,
  ): Promise<LibraryCharacter> {
    return this.json(
      `/api/library/families/${familyId}/characters`,
      "POST",
      input,
    );
  }

  preflightCharacter(
    familyId: string,
    profile: CharacterProfile,
  ): Promise<CharacterPreflightResult> {
    return this.json(
      `/api/library/families/${familyId}/characters/preflight`,
      "POST",
      { profile },
    );
  }

  updateCharacter(
    id: string,
    input: CharacterVersionInput,
  ): Promise<LibraryCharacter> {
    return this.json(`/api/library/characters/${id}`, "PATCH", input);
  }

  setCharacterVisibility(
    id: string,
    action: "archive" | "restore",
  ): Promise<LibraryCharacter> {
    return this.json(`/api/library/characters/${id}/${action}`, "POST", {});
  }

  characterHistory(id: string): Promise<CharacterVersion[]> {
    return this.request(`/api/library/characters/${id}/history`);
  }

  createLook(characterId: string, input: LookInput): Promise<LibraryLook> {
    return this.json(
      `/api/library/characters/${characterId}/looks`,
      "POST",
      input,
    );
  }

  updateLook(id: string, input: LookVersionInput): Promise<LibraryLook> {
    return this.json(`/api/library/looks/${id}`, "PATCH", input);
  }

  setLookVisibility(
    id: string,
    action: "archive" | "restore",
  ): Promise<LibraryLook> {
    return this.json(`/api/library/looks/${id}/${action}`, "POST", {});
  }

  lookHistory(id: string): Promise<LookVersion[]> {
    return this.request(`/api/library/looks/${id}/history`);
  }

  stagePhoto(input: PhotoStageInput): Promise<PhotoIntakeReservation> {
    const form = new FormData();
    form.set("familyId", input.familyId);
    form.set("kind", input.kind);
    form.set("owner", JSON.stringify(input.owner));
    form.set("file", input.file);
    return this.request("/api/library/photo-intake/stage", {
      method: "POST",
      body: form,
    });
  }

  commitPhoto(input: PhotoCommitInput): Promise<PhotoCommitResult> {
    return this.json("/api/library/photo-intake/commit", "POST", input);
  }

  cancelPhoto(reservationToken: string): Promise<void> {
    return this.json("/api/library/photo-intake/cancel", "POST", {
      reservationToken,
    });
  }

  authoringTemplates(
    includeHidden = false,
  ): Promise<AuthoringTemplateRecord[]> {
    return this.request(
      `/api/authoring/templates?includeHidden=${includeHidden ? "true" : "false"}`,
    );
  }

  createAuthoringTemplate(
    content: AuthoringTemplateContent,
  ): Promise<AuthoringTemplateRecord> {
    return this.json("/api/authoring/templates", "POST", { content });
  }

  updateAuthoringTemplate(
    templateId: string,
    input: { expectedVersionId: string; content: AuthoringTemplateContent },
  ): Promise<AuthoringTemplateRecord> {
    return this.json(`/api/authoring/templates/${templateId}`, "PATCH", input);
  }

  duplicateAuthoringTemplate(
    templateId: string,
  ): Promise<AuthoringTemplateRecord> {
    return this.json(
      `/api/authoring/templates/${templateId}/duplicate`,
      "POST",
      {},
    );
  }

  extractAuthoringTemplate(
    familyId: string,
    projectId: string,
    name: string,
  ): Promise<AuthoringTemplateRecord> {
    return this.json(
      `/api/authoring/projects/${projectId}/extract-template?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      { name },
    );
  }

  authoringProjects(familyId: string): Promise<AuthoringProjectWorkspace[]> {
    return this.request(
      `/api/authoring/projects?familyId=${encodeURIComponent(familyId)}`,
    );
  }

  authoringProject(
    familyId: string,
    projectId: string,
  ): Promise<AuthoringProjectWorkspace> {
    return this.request(
      `/api/authoring/projects/${projectId}?familyId=${encodeURIComponent(familyId)}`,
    );
  }

  createAuthoringProject(
    familyId: string,
    input: AuthoringProjectInput,
  ): Promise<AuthoringProjectWorkspace> {
    return this.json(
      `/api/authoring/families/${familyId}/projects`,
      "POST",
      input,
    );
  }

  updateAuthoringProject(
    familyId: string,
    projectId: string,
    input: { expectedVersionId: string; input: AuthoringProjectInput },
  ): Promise<AuthoringProjectWorkspace> {
    return this.json(
      `/api/authoring/projects/${projectId}?familyId=${encodeURIComponent(familyId)}`,
      "PATCH",
      input,
    );
  }

  appendAuthoringOverride(
    familyId: string,
    projectId: string,
    input: {
      expectedProjectVersionId: string;
      expectedOverrideVersionId?: string;
      characterId: string;
      clothing: string;
      appearanceOverrides: Record<string, string>;
    },
  ): Promise<AuthoringOverrideResult> {
    return this.json(
      `/api/authoring/projects/${projectId}/overrides?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  updateAuthoringScene(
    familyId: string,
    projectId: string,
    storyPageIndex: number,
    input: {
      expectedStoryVersionId: string;
      expectedSceneVersionId: string;
      content: AuthoringSceneContent;
    },
  ): Promise<AuthoringProjectWorkspace> {
    return this.json(
      `/api/authoring/projects/${projectId}/scenes/${storyPageIndex}?familyId=${encodeURIComponent(familyId)}`,
      "PATCH",
      input,
    );
  }

  authoringMentions(
    familyId: string,
    projectId: string,
    query = "",
  ): Promise<MentionCandidate[]> {
    const params = new URLSearchParams({ familyId, query });
    return this.request(
      `/api/authoring/projects/${projectId}/mentions?${params.toString()}`,
    );
  }

  preflightPageCount(
    familyId: string,
    projectId: string,
    to: AuthoringPageCount,
  ): Promise<PageCountPlan> {
    return this.json(
      `/api/authoring/projects/${projectId}/page-count/preflight?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      { to },
    );
  }

  confirmPageCount(
    familyId: string,
    projectId: string,
    plan: PageCountPlan,
  ): Promise<AuthoringProjectWorkspace> {
    return this.json(
      `/api/authoring/projects/${projectId}/page-count/confirm?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      plan,
    );
  }

  setAuthoringTemplateStatus(
    templateId: string,
    input: {
      expectedVersionId: string;
      expectedStatus: AuthoringTemplateRecord["status"];
      status: AuthoringTemplateRecord["status"];
    },
  ): Promise<AuthoringTemplateRecord> {
    return this.json(
      `/api/authoring/templates/${templateId}/status`,
      "POST",
      input,
    );
  }
}

export function toSettingsUpdate(settings: Settings): SettingsUpdate {
  const {
    textProvider,
    imageProvider,
    geminiImageTier,
    models,
    concurrencyPerProvider,
    typography,
    watermarkText,
    diskWarnGb,
    photoUploadMaxMb,
    photoMaxMegapixels,
    firstRunAcknowledged,
  } = settings;
  return {
    textProvider,
    imageProvider,
    geminiImageTier,
    models,
    concurrencyPerProvider,
    typography,
    watermarkText,
    diskWarnGb,
    photoUploadMaxMb,
    photoMaxMegapixels,
    firstRunAcknowledged,
  };
}
