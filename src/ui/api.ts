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
} from "./types";

interface BootstrapResponse {
  appName: string;
  direction: "rtl";
  canonicalOrigin: string;
  csrfToken: string;
}

export class ApiError extends Error {
  constructor(
    readonly category: "stale_session" | "request_failed",
    readonly code = "REQUEST_FAILED",
    readonly status = 0,
  ) {
    super(category === "stale_session" ? "STALE_SESSION" : code);
  }
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

export class ApiClient {
  private constructor(private readonly csrfToken: string) {}

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

  health(): Promise<HealthSnapshot> {
    return this.request("/api/health");
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

  private json<T>(path: string, method: string, body: unknown): Promise<T> {
    return this.request(path, { method, body: JSON.stringify(body) });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const unsafe =
      init.method !== undefined && !["GET", "HEAD"].includes(init.method);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined && !(init.body instanceof FormData))
      headers.set("content-type", "application/json");
    if (unsafe) headers.set("x-hekayati-csrf", this.csrfToken);
    const response = await fetch(path, { ...init, headers, cache: "no-store" });
    const errorBody = response.ok ? null : await responseJson(response);
    if (response.status === 403 && !errorBody)
      throw new ApiError("stale_session", "STALE_SESSION", response.status);
    if (!response.ok) {
      const code =
        errorBody && typeof errorBody.code === "string"
          ? errorBody.code
          : "REQUEST_FAILED";
      throw new ApiError("request_failed", code, response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

async function responseJson(
  response: Response,
): Promise<{ code?: unknown } | null> {
  try {
    return (await response.json()) as { code?: unknown };
  } catch {
    return null;
  }
}

export function toSettingsUpdate(settings: Settings): SettingsUpdate {
  const {
    textProvider,
    imageProvider,
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
