import { ApiError } from "./api-error";
import type {
  CreativePolicyConfirmations,
  CreativeFinding,
  CreativePage,
  CreativePageHistory,
  CreativeReviewChecks,
  CreativeRun,
  CreativeSheet,
  CreativeSheetIntent,
  CreativeSnapshot,
} from "./creative-types";

export abstract class CreativeApiClient {
  protected constructor(private readonly csrfToken: string) {}

  creativeProject(
    familyId: string,
    projectId: string,
  ): Promise<CreativeSnapshot> {
    return this.request(
      `/api/creative/projects/${projectId}?familyId=${encodeURIComponent(familyId)}`,
    );
  }

  startCharacterSheet(
    familyId: string,
    projectId: string,
    input: {
      characterId: string;
      expectedProjectVersionId: string;
      priorSheetId?: string | null;
      revisionNotes?: string;
      confirmations?: CreativePolicyConfirmations;
    },
  ): Promise<{ intent: CreativeSheetIntent }> {
    return this.json(
      `/api/creative/projects/${projectId}/sheets?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  approveCharacterSheet(
    familyId: string,
    sheetId: string,
    input: {
      expectedSheetRevision: number;
      intentId: string;
      expectedIntentRevision: number;
      gateJobId: string;
      expectedGateRevision: number;
      notes: string;
    },
  ): Promise<unknown> {
    return this.json(
      `/api/creative/sheets/${sheetId}/approve?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  requestCharacterSheetChanges(
    familyId: string,
    sheet: CreativeSheet,
    intent: CreativeSheetIntent,
    input: {
      expectedProjectVersionId: string;
      gateJobId: string;
      expectedGateRevision: number;
      notes: string;
      confirmations?: CreativePolicyConfirmations;
    },
  ): Promise<unknown> {
    return this.json(
      `/api/creative/sheets/${sheet.id}/change-request?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      {
        expectedSheetRevision: sheet.revision,
        intentId: intent.id,
        expectedIntentRevision: intent.revision,
        expectedProjectVersionId: input.expectedProjectVersionId,
        gateJobId: input.gateJobId,
        expectedGateRevision: input.expectedGateRevision,
        notes: input.notes,
        confirmations: input.confirmations,
      },
    );
  }

  startCreativeRun(
    familyId: string,
    projectId: string,
    input: {
      expectedProjectVersionId: string;
      expectedStoryVersionId: string;
      confirmations?: CreativePolicyConfirmations;
    },
  ): Promise<{ run: CreativeRun }> {
    return this.json(
      `/api/creative/projects/${projectId}/runs?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  creativePageHistory(
    familyId: string,
    pageId: string,
  ): Promise<CreativePageHistory> {
    return this.request(
      `/api/creative/pages/${pageId}/history?familyId=${encodeURIComponent(familyId)}`,
    );
  }

  creativeIllustrationUrl(
    familyId: string,
    pageId: string,
    versionId?: string,
  ): string {
    const version = versionId
      ? `&version=${encodeURIComponent(versionId)}`
      : "";
    return `/api/creative/pages/${pageId}/illustration?familyId=${encodeURIComponent(familyId)}${version}`;
  }

  creativeSheetPdfUrl(familyId: string, sheetId: string): string {
    return `/api/creative/sheets/${sheetId}/pdf?familyId=${encodeURIComponent(familyId)}`;
  }

  creativeSheetViewUrl(
    familyId: string,
    sheetId: string,
    view: CreativeSheetView,
  ): string {
    return `/api/creative/sheets/${sheetId}/views/${view}?familyId=${encodeURIComponent(familyId)}`;
  }

  reviewCreativePage(
    familyId: string,
    page: CreativePage,
    checks: CreativeReviewChecks,
    notes: string,
  ): Promise<{ page: CreativePage }> {
    return this.json(
      `/api/creative/pages/${page.id}/review?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      {
        expectedRevision: page.revision,
        textVersionId: page.currentTextVersionId,
        illustrationVersionId: page.currentIllustrationVersionId,
        checks,
        notes,
      },
    );
  }

  setCreativePageLock(
    familyId: string,
    page: CreativePage,
    action: "lock" | "unlock",
  ): Promise<CreativePage> {
    return this.json(
      `/api/creative/pages/${page.id}/${action}?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      { expectedRevision: page.revision },
    );
  }

  regenerateCreativeIllustration(
    familyId: string,
    runId: string,
    page: CreativePage,
  ): Promise<unknown> {
    return this.json(
      `/api/creative/pages/${page.id}/regenerate-illustration?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      { runId, expectedRevision: page.revision },
    );
  }

  rewriteCreativePageText(
    familyId: string,
    page: CreativePage,
    input: {
      narrative: string;
      dialogue: Array<{ speakerCharacterId: string; text: string }>;
    },
  ): Promise<CreativePage> {
    return this.json(
      `/api/creative/pages/${page.id}/text?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      { expectedRevision: page.revision, ...input },
    );
  }

  revertCreativePageVersion(
    familyId: string,
    page: CreativePage,
    kind: "text" | "illustration",
    targetVersionId: string,
  ): Promise<CreativePage> {
    return this.json(
      `/api/creative/pages/${page.id}/revert-${kind}?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      { expectedRevision: page.revision, targetVersionId },
    );
  }

  requestCreativeLayout(
    familyId: string,
    page: CreativePage,
    reason: string,
  ): Promise<unknown> {
    return this.json(
      `/api/creative/pages/${page.id}/layout-request?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      { expectedRevision: page.revision, reason },
    );
  }

  creativeFindings(
    familyId: string,
    runId: string,
  ): Promise<CreativeFinding[]> {
    return this.request(
      `/api/creative/runs/${runId}/findings?familyId=${encodeURIComponent(familyId)}`,
    );
  }

  acknowledgeCreativeFinding(
    familyId: string,
    runId: string,
    expectedRunRevision: number,
    findingKey: string,
    note: string,
  ): Promise<unknown> {
    return this.json(
      `/api/creative/runs/${runId}/findings/acknowledge?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      { expectedRunRevision, findingKey, note },
    );
  }

  completeCreativeReview(
    familyId: string,
    runId: string,
    input: {
      expectedRunRevision: number;
      gateJobId: string;
      expectedGateRevision: number;
    },
  ): Promise<CreativeRun> {
    return this.json(
      `/api/creative/runs/${runId}/complete-review?familyId=${encodeURIComponent(familyId)}`,
      "POST",
      input,
    );
  }

  protected json<T>(path: string, method: string, body: unknown): Promise<T> {
    return this.request(path, { method, body: JSON.stringify(body) });
  }

  protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
      throw new ApiError(
        "request_failed",
        code,
        response.status,
        errorBody?.details,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

export type CreativeSheetView =
  "face" | "front" | "threeQuarter" | "fullBody" | "mainOutfit";

async function responseJson(response: Response): Promise<{
  code?: unknown;
  details?: Readonly<Record<string, unknown>>;
} | null> {
  try {
    return (await response.json()) as {
      code?: unknown;
      details?: Readonly<Record<string, unknown>>;
    };
  } catch {
    return null;
  }
}
