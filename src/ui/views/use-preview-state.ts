import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, type ApiClient } from "../api";
import type {
  LayoutAffectedItems,
  LayoutApprovalInput,
  LayoutApprovalScope,
  LayoutPageProjection,
  LayoutPlacement,
  LayoutProjectProjection,
} from "../layout-types";
import type { AuthoringProjectWorkspace, LibrarySnapshot } from "../types";

export interface PreviewState {
  library: LibrarySnapshot | null;
  projects: AuthoringProjectWorkspace[];
  familyId: string;
  projectId: string;
  snapshot: LayoutProjectProjection | null;
  affected: LayoutAffectedItems[];
  busy: boolean;
  error: string;
  selectFamily: (id: string) => void;
  selectProject: (id: string) => void;
  reload: () => Promise<void>;
  regenerate: () => Promise<void>;
  recalculate: (
    page: LayoutPageProjection,
    placement: LayoutPlacement,
  ) => Promise<void>;
  changeSource: (
    page: LayoutPageProjection,
    assetId: string | null,
    placement: LayoutPlacement,
  ) => Promise<void>;
  changeCover: (
    assetId: string,
    environmentLine: string,
    synopsis: string,
  ) => Promise<void>;
  approvalAction: (action: "sent" | "approve") => Promise<void>;
  requestChanges: (
    notes: string,
    scopes: LayoutApprovalScope[],
  ) => Promise<void>;
}

export function usePreviewState(client: ApiClient): PreviewState {
  const selection = usePreviewSelection(client);
  const data = useLayoutData(client, selection.familyId, selection.projectId);
  const runner = useMutationRunner(data.reload);
  const context = {
    familyId: selection.familyId,
    projectId: selection.projectId,
    snapshot: data.snapshot,
    run: runner.run,
  };
  const composition = useCompositionActions(client, context);
  const approval = useApprovalActions(client, context);
  return {
    ...selection,
    snapshot: data.snapshot,
    affected: data.affected,
    busy: runner.busy,
    error: runner.error || data.error || selection.error,
    reload: () => runner.run(() => Promise.resolve()),
    ...composition,
    ...approval,
  };
}

function usePreviewSelection(client: ApiClient) {
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [projects, setProjects] = useState<AuthoringProjectWorkspace[]>([]);
  const [familyId, setFamilyId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState("");
  useLibrarySelection(client, setLibrary, setFamilyId, setError);
  useProjectSelection(client, familyId, setProjects, setProjectId, setError);
  return {
    library,
    projects,
    familyId,
    projectId,
    error,
    selectFamily: (id: string) => {
      setFamilyId(id);
      setProjectId("");
      setProjects([]);
    },
    selectProject: setProjectId,
  };
}

function useLibrarySelection(
  client: ApiClient,
  setLibrary: (value: LibrarySnapshot) => void,
  setFamilyId: (value: string) => void,
  setError: (value: string) => void,
) {
  useEffect(() => {
    let active = true;
    void client
      .library()
      .then((value) => {
        if (!active) return;
        setLibrary(value);
        setFamilyId(
          value.families.find((family) => family.status === "active")?.id ?? "",
        );
      })
      .catch((reason) => active && setError(errorMessage(reason)));
    return () => {
      active = false;
    };
  }, [client, setError, setFamilyId, setLibrary]);
}

function useProjectSelection(
  client: ApiClient,
  familyId: string,
  setProjects: (value: AuthoringProjectWorkspace[]) => void,
  setProjectId: (value: string) => void,
  setError: (value: string) => void,
) {
  useEffect(() => {
    if (!familyId) return;
    let active = true;
    void client
      .authoringProjects(familyId)
      .then((value) => {
        if (!active) return;
        setProjects(value);
        setProjectId(value[0]?.project.id ?? "");
      })
      .catch((reason) => active && setError(errorMessage(reason)));
    return () => {
      active = false;
    };
  }, [client, familyId, setError, setProjectId, setProjects]);
}

interface LoadedLayoutData {
  familyId: string;
  projectId: string;
  snapshot: LayoutProjectProjection;
  affected: LayoutAffectedItems[];
}

function useLayoutData(client: ApiClient, familyId: string, projectId: string) {
  const [loaded, setLoaded] = useState<LoadedLayoutData | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    if (!familyId || !projectId) return;
    const snapshot = await client.layoutProject(familyId, projectId);
    const eventIds = snapshot.preview?.invalidatedByEventIds.slice(-5) ?? [];
    const affected = await Promise.all(
      eventIds.map((id) => client.layoutAffectedItems(familyId, id)),
    );
    setLoaded({ familyId, projectId, snapshot, affected });
    setError("");
  }, [client, familyId, projectId]);
  useEffect(() => {
    if (!familyId || !projectId) return;
    const start = window.setTimeout(
      () => void reload().catch((reason) => setError(errorMessage(reason))),
      0,
    );
    const poll = window.setInterval(
      () => void reload().catch(() => undefined),
      2500,
    );
    return () => {
      window.clearTimeout(start);
      window.clearInterval(poll);
    };
  }, [familyId, projectId, reload]);
  const current =
    loaded?.familyId === familyId && loaded.projectId === projectId
      ? loaded
      : null;
  return {
    snapshot: current?.snapshot ?? null,
    affected: current?.affected ?? [],
    error,
    reload,
  };
}

function useMutationRunner(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(
    async (operation: () => Promise<unknown>) => {
      setBusy(true);
      setError("");
      try {
        await operation();
        await reload();
      } catch (reason) {
        setError(errorMessage(reason));
        await reload().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );
  return { busy, error, run };
}

interface ActionContext {
  familyId: string;
  projectId: string;
  snapshot: LayoutProjectProjection | null;
  run: (operation: () => Promise<unknown>) => Promise<void>;
}

function useCompositionActions(client: ApiClient, context: ActionContext) {
  const snapshot = () => requireSnapshot(context.snapshot);
  return {
    regenerate: () =>
      context.run(() => {
        const current = snapshot();
        return client.regenerateLayoutPreview(
          context.familyId,
          context.projectId,
          {
            expectedProjectRevision: current.project.revision,
            expectedWorkflowRevision: current.workflow!.revision,
          },
        );
      }),
    recalculate: (page: LayoutPageProjection, placement: LayoutPlacement) =>
      context.run(() =>
        client.recalculateLayoutPage(context.familyId, page.pageId, {
          expectedRevision: page.revision,
          reason: "إعادة تنسيق يدوية من شاشة المعاينة",
          requestedPlacement: placement,
        }),
      ),
    changeSource: createSourceAction(client, context, snapshot),
    changeCover: createCoverAction(client, context, snapshot),
  };
}

function createSourceAction(
  client: ApiClient,
  context: ActionContext,
  snapshot: () => LayoutProjectProjection,
) {
  return (
    page: LayoutPageProjection,
    assetId: string | null,
    placement: LayoutPlacement,
  ) =>
    context.run(() =>
      client.changeSpecialCompositionSource(context.familyId, page.pageId, {
        expectedPageRevision: page.revision,
        expectedWorkflowRevision: snapshot().workflow!.revision,
        assetId,
        requestedPlacement: placement,
      }),
    );
}

function createCoverAction(
  client: ApiClient,
  context: ActionContext,
  snapshot: () => LayoutProjectProjection,
) {
  return (assetId: string, environmentLine: string, synopsis: string) =>
    context.run(() => {
      const current = snapshot();
      return client.changeCoverComposition(
        context.familyId,
        context.projectId,
        {
          expectedProjectRevision: current.project.revision,
          expectedWorkflowRevision: current.workflow!.revision,
          expectedCoverVersionId: current.cover!.id,
          frontArtworkAssetId: assetId,
          backArtworkAssetId: null,
          environmentLine: environmentLine.trim() || null,
          synopsis: synopsis.trim() || null,
        },
      );
    });
}

function useApprovalActions(client: ApiClient, context: ActionContext) {
  const keys = useRef(new Map<string, string>());
  const keyFor = (kind: string) => {
    const key = keys.current.get(kind) ?? crypto.randomUUID();
    keys.current.set(kind, key);
    return key;
  };
  return {
    approvalAction: (action: "sent" | "approve") =>
      context.run(async () => {
        const snapshot = requireSnapshot(context.snapshot);
        await client.recordLayoutApprovalAction(
          context.familyId,
          snapshot.preview!.id,
          action,
          approvalInput(snapshot, keyFor(action)),
        );
        keys.current.delete(action);
      }),
    requestChanges: (notes: string, scopes: LayoutApprovalScope[]) =>
      context.run(async () => {
        const snapshot = requireSnapshot(context.snapshot);
        await client.requestLayoutChanges(
          context.familyId,
          snapshot.preview!.id,
          {
            ...approvalInput(snapshot, keyFor("changes")),
            notes,
            affectedScopes: scopes,
          },
        );
        keys.current.delete("changes");
      }),
  };
}

function approvalInput(
  snapshot: LayoutProjectProjection,
  idempotencyKey: string,
): LayoutApprovalInput {
  if (!snapshot.preview || !snapshot.approval || !snapshot.approvalGate)
    throw new Error("LAYOUT_NOT_READY");
  return {
    cycleId: snapshot.approval.id,
    idempotencyKey,
    customerContentHash: snapshot.preview.customerContentHash,
    approvalBundleHash: snapshot.preview.approvalBundleHash,
    expectedProjectRevision: snapshot.project.revision,
    expectedPreviewOutputRevision: snapshot.preview.revision,
    expectedApprovalRevision: snapshot.approval.revision,
    expectedGateRevision: snapshot.approvalGate.revision,
    expectedContentApprovalId: snapshot.project.currentContentApprovalId,
    expectedContentApprovalRevision: snapshot.project.currentContentApprovalId
      ? (snapshot.contentApproval?.revision ?? null)
      : null,
  };
}

function requireSnapshot(value: LayoutProjectProjection | null) {
  if (!value) throw new Error("LAYOUT_NOT_READY");
  return value;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof ApiError && reason.code.includes("REVISION"))
    return "تغيّرت النسخة في تبويب آخر. حدّث الحالة ثم أعد المحاولة.";
  if (reason instanceof ApiError && reason.code.includes("LOCKED"))
    return "الصفحة مقفلة. افتحها من شاشة المراجعة أولًا.";
  return "تعذّر تنفيذ الطلب. راجع الحالة الحالية ثم أعد المحاولة.";
}
