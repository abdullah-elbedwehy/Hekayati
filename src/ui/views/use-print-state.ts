import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { ApiError, type ApiClient } from "../api";
import type {
  PrinterProfileProjection,
  PrintProfileDraft,
  PrintProjectProjection,
} from "../print-types";
import type { AuthoringProjectWorkspace, LibrarySnapshot } from "../types";

export interface PrintState {
  library: LibrarySnapshot | null;
  projects: AuthoringProjectWorkspace[];
  profiles: PrinterProfileProjection[];
  familyId: string;
  projectId: string;
  snapshot: PrintProjectProjection | null;
  busy: boolean;
  error: string;
  selectFamily: (id: string) => void;
  selectProject: (id: string) => void;
  reload: () => Promise<void>;
  saveProfile: (
    name: string,
    draft: PrintProfileDraft,
    existing: PrinterProfileProjection | null,
  ) => Promise<void>;
  assignProfile: (profile: PrinterProfileProjection) => Promise<void>;
  importIcc: (file: File) => ReturnType<ApiClient["importPrintIcc"]>;
  importTemplate: (
    file: File,
    geometry: Parameters<ApiClient["importPrintTemplate"]>[1],
  ) => ReturnType<ApiClient["importPrintTemplate"]>;
  start: () => Promise<void>;
  proof: (action: "approved" | "rejected", notes?: string) => Promise<void>;
}

interface CatalogState {
  library: LibrarySnapshot | null;
  projects: AuthoringProjectWorkspace[];
  profiles: PrinterProfileProjection[];
  familyId: string;
  projectId: string;
  setProfiles: Dispatch<SetStateAction<PrinterProfileProjection[]>>;
  selectFamily: (id: string) => void;
  selectProject: (id: string) => void;
}

interface ProjectionState {
  snapshot: PrintProjectProjection | null;
  clear: () => void;
  reload: () => Promise<void>;
}

interface ActionContext {
  client: ApiClient;
  catalog: CatalogState;
  projection: ProjectionState;
  mutate: (operation: () => Promise<unknown>) => Promise<void>;
  keyFor: (kind: string) => string;
  clearKey: (kind: string) => void;
}

export function usePrintState(client: ApiClient): PrintState {
  const [error, setError] = useState("");
  const catalog = usePrintCatalog(client, setError);
  const projection = usePrintProjection(client, catalog, setError);
  const { busy, mutate } = usePrintMutation(projection.reload, setError);
  const keys = useIdempotencyKeys();
  const actions = createPrintActions({
    client,
    catalog,
    projection,
    mutate,
    keyFor: keys.get,
    clearKey: keys.clear,
  });
  return {
    ...catalog,
    snapshot: projection.snapshot,
    busy,
    error,
    selectFamily: (id) => {
      projection.clear();
      catalog.selectFamily(id);
    },
    selectProject: (id) => {
      projection.clear();
      catalog.selectProject(id);
    },
    reload: projection.reload,
    ...actions,
  };
}

function usePrintCatalog(
  client: ApiClient,
  setError: Dispatch<SetStateAction<string>>,
): CatalogState {
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [projects, setProjects] = useState<AuthoringProjectWorkspace[]>([]);
  const [profiles, setProfiles] = useState<PrinterProfileProjection[]>([]);
  const [familyId, setFamilyId] = useState("");
  const [projectId, setProjectId] = useState("");
  useInitialPrintCatalog(
    client,
    setLibrary,
    setProfiles,
    setFamilyId,
    setError,
  );
  useFamilyProjects(client, familyId, setProjects, setProjectId, setError);
  return {
    library,
    projects,
    profiles,
    familyId,
    projectId,
    setProfiles,
    selectFamily: (id) => {
      setProjects([]);
      setProjectId("");
      setFamilyId(id);
    },
    selectProject: setProjectId,
  };
}

function useInitialPrintCatalog(
  client: ApiClient,
  setLibrary: Dispatch<SetStateAction<LibrarySnapshot | null>>,
  setProfiles: Dispatch<SetStateAction<PrinterProfileProjection[]>>,
  setFamilyId: Dispatch<SetStateAction<string>>,
  setError: Dispatch<SetStateAction<string>>,
): void {
  useEffect(() => {
    let active = true;
    void Promise.all([client.library(), client.printProfiles()])
      .then(([library, profiles]) => {
        if (!active) return;
        setLibrary(library);
        setProfiles(profiles);
        setFamilyId(
          library.families.find((item) => item.status === "active")?.id ?? "",
        );
      })
      .catch((reason: unknown) => active && setError(message(reason)));
    return () => {
      active = false;
    };
  }, [client, setError, setFamilyId, setLibrary, setProfiles]);
}

function useFamilyProjects(
  client: ApiClient,
  familyId: string,
  setProjects: Dispatch<SetStateAction<AuthoringProjectWorkspace[]>>,
  setProjectId: Dispatch<SetStateAction<string>>,
  setError: Dispatch<SetStateAction<string>>,
): void {
  useEffect(() => {
    if (!familyId) return;
    let active = true;
    void client
      .authoringProjects(familyId)
      .then((projects) => {
        if (!active) return;
        setProjects(projects);
        setProjectId(projects[0]?.project.id ?? "");
      })
      .catch((reason: unknown) => active && setError(message(reason)));
    return () => {
      active = false;
    };
  }, [client, familyId, setError, setProjectId, setProjects]);
}

function usePrintProjection(
  client: ApiClient,
  catalog: CatalogState,
  setError: Dispatch<SetStateAction<string>>,
): ProjectionState {
  const [snapshot, setSnapshot] = useState<PrintProjectProjection | null>(null);
  const { familyId, projectId, setProfiles } = catalog;
  const reload = useCallback(async () => {
    setProfiles(await client.printProfiles());
    if (!familyId || !projectId) {
      setSnapshot(null);
      return;
    }
    setSnapshot(await client.printProject(familyId, projectId));
    setError("");
  }, [client, familyId, projectId, setError, setProfiles]);
  usePrintPolling(familyId, projectId, reload, setError);
  return { snapshot, clear: () => setSnapshot(null), reload };
}

function usePrintPolling(
  familyId: string,
  projectId: string,
  reload: () => Promise<void>,
  setError: Dispatch<SetStateAction<string>>,
): void {
  useEffect(() => {
    if (!familyId || !projectId) return;
    const initial = window.setTimeout(
      () => void reload().catch((reason: unknown) => setError(message(reason))),
      0,
    );
    const poll = window.setInterval(
      () => void reload().catch(() => undefined),
      2500,
    );
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(poll);
    };
  }, [familyId, projectId, reload, setError]);
}

function usePrintMutation(
  reload: () => Promise<void>,
  setError: Dispatch<SetStateAction<string>>,
) {
  const [busy, setBusy] = useState(false);
  const mutate = useCallback(
    async (operation: () => Promise<unknown>) => {
      setBusy(true);
      setError("");
      try {
        await operation();
        await reload();
      } catch (reason) {
        await reload().catch(() => undefined);
        setError(message(reason));
      } finally {
        setBusy(false);
      }
    },
    [reload, setError],
  );
  return { busy, mutate };
}

function useIdempotencyKeys() {
  const keys = useRef(new Map<string, string>());
  return {
    get: (kind: string) => {
      const key = keys.current.get(kind) ?? crypto.randomUUID();
      keys.current.set(kind, key);
      return key;
    },
    clear: (kind: string) => keys.current.delete(kind),
  };
}

function createPrintActions(context: ActionContext) {
  return {
    saveProfile: (
      name: string,
      draft: PrintProfileDraft,
      existing: PrinterProfileProjection | null,
    ) => saveProfile(context, name, draft, existing),
    assignProfile: (profile: PrinterProfileProjection) =>
      assignProfile(context, profile),
    importIcc: (file: File) => context.client.importPrintIcc(file),
    importTemplate: (
      file: File,
      geometry: Parameters<ApiClient["importPrintTemplate"]>[1],
    ) => context.client.importPrintTemplate(file, geometry),
    start: () => startRun(context),
    proof: (action: "approved" | "rejected", notes?: string) =>
      actOnProof(context, action, notes),
  };
}

async function saveProfile(
  context: ActionContext,
  name: string,
  draft: PrintProfileDraft,
  existing: PrinterProfileProjection | null,
): Promise<void> {
  await context.mutate(() =>
    existing
      ? context.client.updatePrintProfile(existing.profile.id, {
          expectedRevision: existing.profile.revision,
          name,
          archived: false,
          draft,
        })
      : context.client.createPrintProfile({ name, draft }),
  );
}

async function assignProfile(
  context: ActionContext,
  profile: PrinterProfileProjection,
): Promise<void> {
  await context.mutate(() => {
    const snapshot = context.projection.snapshot;
    if (!snapshot) throw new Error("PRINT_PROJECT_NOT_READY");
    return context.client.assignPrintProfile(
      context.catalog.familyId,
      context.catalog.projectId,
      {
        expectedProjectRevision: snapshot.project.revision,
        profileId: profile.profile.id,
        expectedProfileRevision: profile.profile.revision,
        profileVersionId: profile.version.id,
      },
    );
  });
}

async function startRun(context: ActionContext): Promise<void> {
  await context.mutate(async () => {
    const snapshot = context.projection.snapshot;
    if (!snapshot?.profile || !snapshot.profileVersion)
      throw new Error("PRINT_PROFILE_NOT_ASSIGNED");
    const authorization = await context.client.approvedLayoutSnapshotStatus(
      context.catalog.familyId,
      context.catalog.projectId,
    );
    if (authorization.state !== "authorized")
      throw new Error(authorization.code);
    await context.client.startPrintRun(
      context.catalog.familyId,
      context.catalog.projectId,
      startInput(
        snapshot,
        authorization.snapshot.contentAuthorizationHash,
        context,
      ),
    );
    context.clearKey("start");
  });
}

function startInput(
  snapshot: PrintProjectProjection,
  contentAuthorizationHash: string,
  context: ActionContext,
) {
  if (!snapshot.profile || !snapshot.profileVersion)
    throw new Error("PRINT_PROFILE_NOT_ASSIGNED");
  return {
    expectedProjectRevision: snapshot.project.revision,
    profileId: snapshot.profile.id,
    expectedProfileRevision: snapshot.profile.revision,
    profileVersionId: snapshot.profileVersion.id,
    contentAuthorizationHash,
    idempotencyKey: context.keyFor("start"),
  };
}

async function actOnProof(
  context: ActionContext,
  action: "approved" | "rejected",
  notes?: string,
): Promise<void> {
  await context.mutate(async () => {
    const snapshot = context.projection.snapshot;
    const run = snapshot?.run;
    const proof = snapshot?.proof;
    const gate = snapshot?.proofGate;
    if (!run || !proof || !gate) throw new Error("PRINT_PROOF_NOT_READY");
    const keyKind = `proof-${action}`;
    await context.client.actOnPrintProof(context.catalog.familyId, run.id, {
      proofBundleId: proof.id,
      gateJobId: gate.id,
      action,
      idempotencyKey: context.keyFor(keyKind),
      expectedRunRevision: run.revision,
      expectedGateRevision: gate.revision,
      proofBundleHash: proof.bundleHash,
      contentAuthorizationHash: proof.contentAuthorizationHash,
      printerProfileHash: proof.printerProfileHash,
      iccChecksum: proof.iccChecksum,
      ...(notes === undefined ? {} : { notes }),
    });
    context.clearKey(keyKind);
  });
}

function message(reason: unknown): string {
  if (reason instanceof ApiError && reason.code.includes("REVISION"))
    return "تغيّرت النسخة في تبويب آخر. حدّث الحالة ثم أعد المحاولة.";
  if (
    reason instanceof ApiError &&
    reason.code === "COMPOSITION_PROFILE_MISMATCH"
  )
    return "مقاس الطابعة لا يطابق التكوين المعتمد. يلزم ترحيل التكوين واعتماده من جديد.";
  if (reason instanceof ApiError && reason.code.includes("PROOF"))
    return "إجراء بروفة الألوان لا يطابق النسخة الحالية.";
  return "تعذّر تنفيذ إجراء الطباعة. راجع الاعتماد وبيانات الطابعة ثم حاول مرة أخرى.";
}
