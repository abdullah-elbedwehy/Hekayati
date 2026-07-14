import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { ApiError, type ApiClient } from "../api";
import type {
  AuthoringProjectWorkspace,
  CreativeFinding,
  CreativePage,
  CreativePolicyChallengeCode,
  CreativePolicyConfirmations,
  CreativeReviewChecks,
  CreativeRun,
  CreativeSheet,
  CreativeSheetIntent,
  CreativeSnapshot,
  LibrarySnapshot,
} from "../types";

interface CreativeData {
  library: LibrarySnapshot | null;
  projects: AuthoringProjectWorkspace[];
  familyId: string;
  workspace: AuthoringProjectWorkspace | null;
  snapshot: CreativeSnapshot | null;
  findings: CreativeFinding[];
  loading: boolean;
  busyId: string;
  error: string;
  policyChallenge: PolicyChallenge | null;
}

export interface PolicyChallenge {
  code: CreativePolicyChallengeCode;
  details: Readonly<Record<string, unknown>>;
  confirm: () => Promise<void>;
}

const initialData: CreativeData = {
  library: null,
  projects: [],
  familyId: "",
  workspace: null,
  snapshot: null,
  findings: [],
  loading: true,
  busyId: "",
  error: "",
  policyChallenge: null,
};

export function useCreativeState(client: ApiClient) {
  const [data, setData] = useState<CreativeData>(initialData);
  const run = useMemo(
    () => newestRun(data.snapshot?.runs ?? []),
    [data.snapshot],
  );
  const reload = useCallback(async () => {
    if (data.familyId && data.workspace)
      await refreshProject(client, data.familyId, data.workspace, setData);
  }, [client, data.familyId, data.workspace]);
  const { selectFamily, selectProject } = useCreativeSelectors(
    client,
    data,
    setData,
  );
  useLibrary(client, setData);
  useCreativePolling(data, run, reload);
  const actions = creativeActions(client, data, run, reload, setData);
  return {
    ...data,
    run,
    reload,
    selectFamily,
    selectProject,
    ...actions,
    dismissPolicyChallenge: () =>
      setData((prior) => ({ ...prior, policyChallenge: null })),
    sheetsReady: sheetsReady(data.workspace, data.snapshot),
  };
}

function useCreativeSelectors(
  client: ApiClient,
  data: CreativeData,
  setData: DataSetter,
) {
  const selectFamily = useCallback(
    (familyId: string) => {
      setData((prior) => ({
        ...prior,
        familyId,
        projects: [],
        workspace: null,
        snapshot: null,
        findings: [],
        loading: Boolean(familyId),
        error: "",
        policyChallenge: null,
      }));
      if (familyId) void loadFamily(client, familyId, setData);
    },
    [client, setData],
  );
  const selectProject = useCallback(
    (projectId: string) => {
      const workspace =
        data.projects.find((item) => item.project.id === projectId) ?? null;
      setData((prior) => ({
        ...prior,
        workspace,
        snapshot: null,
        findings: [],
        policyChallenge: null,
      }));
      if (workspace)
        void refreshProject(client, data.familyId, workspace, setData);
    },
    [client, data.familyId, data.projects, setData],
  );
  return { selectFamily, selectProject };
}

function useLibrary(client: ApiClient, setData: DataSetter): void {
  useEffect(() => {
    let active = true;
    void client
      .library()
      .then((library) => {
        if (active) setData((prior) => ({ ...prior, library, loading: false }));
      })
      .catch((reason: unknown) => {
        if (active)
          setData((prior) => ({
            ...prior,
            error: errorMessage(reason),
            loading: false,
          }));
      });
    return () => {
      active = false;
    };
  }, [client, setData]);
}

function useCreativePolling(
  data: CreativeData,
  run: CreativeRun | null,
  reload: () => Promise<void>,
): void {
  const live =
    data.snapshot?.sheetIntents.some((item) =>
      ["planned", "generating", "finalizing"].includes(item.status),
    ) || run?.status === "generating";
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void reload(), 750);
    return () => window.clearInterval(timer);
  }, [live, reload]);
}

type DataSetter = Dispatch<SetStateAction<CreativeData>>;

async function loadFamily(
  client: ApiClient,
  familyId: string,
  setData: DataSetter,
): Promise<void> {
  try {
    const projects = await client.authoringProjects(familyId);
    const workspace = projects[0] ?? null;
    setData((prior) => ({
      ...prior,
      projects,
      workspace,
      loading: Boolean(workspace),
    }));
    if (workspace) await refreshProject(client, familyId, workspace, setData);
  } catch (reason) {
    setData((prior) => ({
      ...prior,
      error: errorMessage(reason),
      loading: false,
    }));
  }
}

async function refreshProject(
  client: ApiClient,
  familyId: string,
  workspace: AuthoringProjectWorkspace,
  setData: DataSetter,
): Promise<void> {
  try {
    const [nextWorkspace, snapshot] = await Promise.all([
      client.authoringProject(familyId, workspace.project.id),
      client.creativeProject(familyId, workspace.project.id),
    ]);
    const run = newestRun(snapshot.runs);
    const findings =
      run && ["internal_review", "complete"].includes(run.status)
        ? await client.creativeFindings(familyId, run.id)
        : [];
    setData((prior) => ({
      ...prior,
      workspace: nextWorkspace,
      snapshot,
      findings,
      error: "",
      loading: false,
    }));
  } catch (reason) {
    setData((prior) => ({
      ...prior,
      error: errorMessage(reason),
      loading: false,
    }));
  }
}

function creativeActions(
  client: ApiClient,
  data: CreativeData,
  run: CreativeRun | null,
  reload: () => Promise<void>,
  setData: DataSetter,
) {
  const perform = createPerformer(reload, setData);
  const performPolicy = createPolicyPerformer(reload, setData);
  return {
    ...sheetActions(client, data, perform, performPolicy),
    ...runActions(client, data, run, perform, performPolicy),
    ...pageActions(client, data, run, perform),
  };
}

type Performer = (id: string, action: () => Promise<unknown>) => Promise<void>;
type PolicyPerformer = (
  id: string,
  action: (confirmations: CreativePolicyConfirmations) => Promise<unknown>,
  confirmations?: CreativePolicyConfirmations,
) => Promise<void>;

function createPerformer(
  reload: () => Promise<void>,
  setData: DataSetter,
): Performer {
  return async (id, action) => {
    setData((prior) => ({ ...prior, busyId: id, error: "" }));
    try {
      await action();
      await reload();
    } catch (reason) {
      setData((prior) => ({ ...prior, error: errorMessage(reason) }));
    } finally {
      setData((prior) => ({ ...prior, busyId: "" }));
    }
  };
}

function createPolicyPerformer(
  reload: () => Promise<void>,
  setData: DataSetter,
): PolicyPerformer {
  const performPolicy: PolicyPerformer = async (
    id,
    action,
    confirmations = {},
  ) => {
    setData((prior) => ({
      ...prior,
      busyId: id,
      error: "",
      policyChallenge: null,
    }));
    try {
      await action(confirmations);
      await reload();
    } catch (reason) {
      const challenge = policyConfirmation(reason, confirmations);
      if (challenge) {
        setData((prior) => ({
          ...prior,
          error: "",
          policyChallenge: {
            code: challenge.code,
            details: challenge.details,
            confirm: () => performPolicy(id, action, challenge.confirmations),
          },
        }));
      } else {
        setData((prior) => ({ ...prior, error: errorMessage(reason) }));
      }
    } finally {
      setData((prior) => ({ ...prior, busyId: "" }));
    }
  };
  return performPolicy;
}

function sheetActions(
  client: ApiClient,
  data: CreativeData,
  perform: Performer,
  performPolicy: PolicyPerformer,
) {
  return {
    ...sheetDecisionActions(client, data, perform, performPolicy),
    generateSheet: (characterId: string) =>
      performPolicy(characterId, (confirmations) => {
        const workspace = requireWorkspace(data);
        return client.startCharacterSheet(data.familyId, workspace.project.id, {
          characterId,
          expectedProjectVersionId: workspace.version.id,
          confirmations,
        });
      }),
  };
}

function sheetDecisionActions(
  client: ApiClient,
  data: CreativeData,
  perform: Performer,
  performPolicy: PolicyPerformer,
) {
  return {
    approveSheet: (
      sheet: CreativeSheet,
      intent: CreativeSheetIntent,
      notes: string,
    ) =>
      perform(sheet.characterId, async () => {
        if (!intent.approvalGateJobId) throw new Error("APPROVAL_GATE_MISSING");
        const gate = await client.job(intent.approvalGateJobId);
        await client.approveCharacterSheet(data.familyId, sheet.id, {
          expectedSheetRevision: sheet.revision,
          intentId: intent.id,
          expectedIntentRevision: intent.revision,
          gateJobId: gate.id,
          expectedGateRevision: gate.revision,
          notes,
        });
      }),
    requestSheetChanges: (
      sheet: CreativeSheet,
      intent: CreativeSheetIntent,
      notes: string,
    ) =>
      performPolicy(sheet.characterId, async (confirmations) => {
        const workspace = requireWorkspace(data);
        if (!intent.approvalGateJobId) throw new Error("APPROVAL_GATE_MISSING");
        const gate = await client.job(intent.approvalGateJobId);
        return client.requestCharacterSheetChanges(
          data.familyId,
          sheet,
          intent,
          {
            expectedProjectVersionId: workspace.version.id,
            gateJobId: gate.id,
            expectedGateRevision: gate.revision,
            notes,
            confirmations,
          },
        );
      }),
  };
}

function runActions(
  client: ApiClient,
  data: CreativeData,
  run: CreativeRun | null,
  perform: Performer,
  performPolicy: PolicyPerformer,
) {
  return {
    startRun: () =>
      performPolicy("run", (confirmations) => {
        const workspace = requireWorkspace(data);
        return client.startCreativeRun(data.familyId, workspace.project.id, {
          expectedProjectVersionId: workspace.version.id,
          expectedStoryVersionId: workspace.storyVersion.id,
          confirmations,
        });
      }),
    completeReview: () =>
      perform("complete", async () => {
        if (!run?.internalReviewGateJobId)
          throw new Error("REVIEW_GATE_MISSING");
        const gate = await client.job(run.internalReviewGateJobId);
        await client.completeCreativeReview(data.familyId, run.id, {
          expectedRunRevision: run.revision,
          gateJobId: gate.id,
          expectedGateRevision: gate.revision,
        });
      }),
    acknowledgeFinding: (finding: CreativeFinding, note: string) =>
      perform(`finding:${finding.key}`, () => {
        if (!run) throw new Error("CREATIVE_RUN_MISSING");
        return client.acknowledgeCreativeFinding(
          data.familyId,
          run.id,
          run.revision,
          finding.key,
          note,
        );
      }),
  };
}

function pageActions(
  client: ApiClient,
  data: CreativeData,
  run: CreativeRun | null,
  perform: Performer,
) {
  return {
    ...pageEditActions(client, data, perform),
    reviewPage: (
      page: CreativePage,
      checks: CreativeReviewChecks,
      notes: string,
    ) =>
      perform(`page:${page.id}`, () =>
        client.reviewCreativePage(data.familyId, page, checks, notes),
      ),
    setPageLock: (page: CreativePage, action: "lock" | "unlock") =>
      perform(`page:${page.id}`, () =>
        client.setCreativePageLock(data.familyId, page, action),
      ),
    regeneratePage: (page: CreativePage) =>
      perform(`page:${page.id}`, async () => {
        if (!run) throw new Error("CREATIVE_RUN_MISSING");
        await client.regenerateCreativeIllustration(
          data.familyId,
          run.id,
          page,
        );
        const workspace = requireWorkspace(data);
        await waitForIllustrationChange(
          client,
          data.familyId,
          workspace.project.id,
          page,
        );
      }),
  };
}

async function waitForIllustrationChange(
  client: ApiClient,
  familyId: string,
  projectId: string,
  page: CreativePage,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await client.creativeProject(familyId, projectId);
    const current = snapshot.pages.find((item) => item.id === page.id);
    if (
      current?.currentIllustrationVersionId &&
      current.currentIllustrationVersionId !== page.currentIllustrationVersionId
    )
      return;
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  throw new Error("CREATIVE_PAGE_UPDATE_TIMEOUT");
}

function pageEditActions(
  client: ApiClient,
  data: CreativeData,
  perform: Performer,
) {
  return {
    rewritePageText: (
      page: CreativePage,
      narrative: string,
      dialogue: Array<{ speakerCharacterId: string; text: string }>,
    ) =>
      perform(`page:${page.id}`, () =>
        client.rewriteCreativePageText(data.familyId, page, {
          narrative,
          dialogue,
        }),
      ),
    revertPageVersion: (
      page: CreativePage,
      kind: "text" | "illustration",
      targetVersionId: string,
    ) =>
      perform(`page:${page.id}`, () =>
        client.revertCreativePageVersion(
          data.familyId,
          page,
          kind,
          targetVersionId,
        ),
      ),
    requestPageLayout: (page: CreativePage) =>
      perform(`page:${page.id}`, () =>
        client.requestCreativeLayout(
          data.familyId,
          page,
          "طلب المشغّل إعادة حساب تخطيط الصفحة فقط",
        ),
      ),
  };
}

function requireWorkspace(data: CreativeData): AuthoringProjectWorkspace {
  if (!data.workspace) throw new Error("CREATIVE_WORKSPACE_MISSING");
  return data.workspace;
}

function sheetsReady(
  workspace: AuthoringProjectWorkspace | null,
  snapshot: CreativeSnapshot | null,
): boolean {
  return Boolean(
    workspace &&
    workspace.version.storyConfig.participants.every((participant) =>
      snapshot?.sheets.some(
        (sheet) =>
          sheet.characterId === participant.characterId &&
          sheet.characterVersionId === participant.characterVersionId &&
          sheet.status === "approved",
      ),
    ),
  );
}

function newestRun(runs: CreativeRun[]) {
  return (
    [...runs].sort((left, right) => right.id.localeCompare(left.id))[0] ?? null
  );
}

const policyChallengeCodes = new Set<CreativePolicyChallengeCode>([
  "CREATIVE_POLICY_CONFIRMATION_REQUIRED",
  "CREATIVE_POLICY_CONFIRMATION_STALE",
  "CREATIVE_CAPACITY_CONFIRMATION_REQUIRED",
  "CREATIVE_CAPACITY_CONFIRMATION_STALE",
]);

function policyConfirmation(
  reason: unknown,
  existing: CreativePolicyConfirmations,
): {
  code: CreativePolicyChallengeCode;
  details: Readonly<Record<string, unknown>>;
  confirmations: CreativePolicyConfirmations;
} | null {
  if (
    !(reason instanceof ApiError) ||
    !policyChallengeCodes.has(reason.code as CreativePolicyChallengeCode) ||
    !isRecord(reason.details)
  )
    return null;
  const code = reason.code as CreativePolicyChallengeCode;
  const bindingHash = reason.details.bindingHash;
  if (!isSha256(bindingHash)) return null;
  if (code.startsWith("CREATIVE_POLICY_")) {
    if (reason.details.policyVersion !== "prompt-policy-v1") return null;
    return {
      code,
      details: safeChallengeDetails(code, reason.details),
      confirmations: {
        ...existing,
        prompt: {
          policyVersion: "prompt-policy-v1",
          bindingHash,
          confirmed: true,
        },
      },
    };
  }
  return {
    code,
    details: safeChallengeDetails(code, reason.details),
    confirmations: {
      ...existing,
      capacity: { bindingHash, confirmed: true },
    },
  };
}

function safeChallengeDetails(
  code: CreativePolicyChallengeCode,
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (code.startsWith("CREATIVE_POLICY_")) {
    const matchedCategories = Array.isArray(details.matchedCategories)
      ? details.matchedCategories.filter(
          (value) =>
            value === "franchise_trademark" || value === "living_artist",
        )
      : [];
    return { matchedCategories };
  }
  const safe: Record<string, unknown> = {};
  for (const key of ["maxReferenceImages", "reliableCharacterCount"])
    if (Number.isInteger(details[key]) && Number(details[key]) > 0)
      safe[key] = details[key];
  if (details.participantExcess === true) safe.participantExcess = true;
  if (Array.isArray(details.counts))
    safe.counts = details.counts.flatMap((value) => {
      if (!isRecord(value)) return [];
      if (
        !Number.isInteger(value.requested) ||
        !Number.isInteger(value.selected)
      )
        return [];
      return [{ requested: value.requested, selected: value.selected }];
    });
  return safe;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function errorMessage(reason: unknown) {
  if (!(reason instanceof ApiError)) return "تعذّر تحديث مساحة الإبداع.";
  const known: Record<string, string> = {
    CREATIVE_SHEET_NOT_APPROVED: "اعتمد كل أوراق الشخصيات أولًا.",
    CREATIVE_REVISION_CONFLICT: "تغيّرت النسخة. حُدّثت الشاشة، أعد المحاولة.",
    CREATIVE_FINDINGS_BLOCK: "توجد ملاحظة مانعة تحتاج إقرارًا صريحًا.",
    CREATIVE_PAGE_LOCKED: "الصفحة مقفلة. فك القفل قبل التعديل.",
  };
  return known[reason.code] ?? `تعذّرت العملية (${reason.code}).`;
}
