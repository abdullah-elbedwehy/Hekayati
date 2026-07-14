import { useCallback, useEffect, useMemo, useState } from "react";

import type { ApiClient } from "../api";
import { ApiError } from "../api";
import { ProjectCreateForm } from "../components/authoring/ProjectCreateForm";
import { ProjectWorkspaceView } from "../components/authoring/ProjectWorkspace";
import type {
  AuthoringProjectInput,
  AuthoringProjectWorkspace,
  AuthoringTemplateRecord,
  LibrarySnapshot,
} from "../types";

export function ProjectsView({ client }: { client: ApiClient }) {
  const state = useProjectsState(client);
  if (state.loading) return <ProjectsLoading />;
  if (!state.library) return <ProjectsFailure message={state.error} />;
  return (
    <main className="view view--projects" id="main-content">
      <ProjectsHeader onRefresh={state.reload} />
      {state.error ? (
        <p className="authoring-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <FamilySelector
        library={state.library}
        familyId={state.familyId}
        onSelect={state.selectFamily}
      />
      {!state.familyId ? (
        <ProjectsEmpty />
      ) : (
        <div className="authoring-shell">
          <ProjectRail
            projects={state.projects}
            selectedId={state.workspace?.project.id}
            onSelect={state.selectProject}
            onCreate={() => state.setCreating(true)}
          />
          <AuthoringContent state={state} client={client} />
        </div>
      )}
    </main>
  );
}

function ProjectsHeader({ onRefresh }: { onRefresh: () => Promise<void> }) {
  return (
    <header className="view-header view-header--with-action authoring-view-header">
      <div>
        <p className="eyebrow">تأليف محلي بلا توليد</p>
        <h1>المشاريع والقصص</h1>
        <p>
          تكوين ثابت للشخصيات والصفحات، وكتابة مشهدية بإشارات مرتبطة بالهوية.
        </p>
      </div>
      <button
        className="button button--secondary"
        type="button"
        onClick={() => void onRefresh()}
      >
        تحديث مساحة العمل
      </button>
    </header>
  );
}

function FamilySelector({
  library,
  familyId,
  onSelect,
}: {
  library: LibrarySnapshot;
  familyId: string;
  onSelect: (id: string) => void;
}) {
  const active = library.families.filter(
    (family) => family.status === "active" && family.anchorCharacterId,
  );
  return (
    <section className="authoring-family-bar" aria-label="اختيار عائلة المشروع">
      <label className="field">
        <span>العائلة</span>
        <select
          value={familyId}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">اختر عائلة لها طفل محور</option>
          {active.map((family) => (
            <option key={family.id} value={family.id}>
              {family.name}
            </option>
          ))}
        </select>
      </label>
      <p>كل مشروع يبقى داخل عائلة واحدة. لا يمكن إدخال شخصية من عائلة أخرى.</p>
    </section>
  );
}

function ProjectRail({
  projects,
  selectedId,
  onSelect,
  onCreate,
}: {
  projects: AuthoringProjectWorkspace[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <aside className="project-rail" aria-label="مشاريع العائلة">
      <div className="project-rail-heading">
        <div>
          <p className="eyebrow">مشاريع العائلة</p>
          <h2>{projects.length}</h2>
        </div>
        <button type="button" onClick={onCreate} aria-label="إنشاء مشروع جديد">
          +
        </button>
      </div>
      <div className="project-list">
        {projects.map((workspace) => (
          <button
            key={workspace.project.id}
            type="button"
            className={
              workspace.project.id === selectedId
                ? "project-list-item project-list-item--active"
                : "project-list-item"
            }
            onClick={() => onSelect(workspace.project.id)}
          >
            <strong>{workspace.version.storyConfig.title}</strong>
            <span>
              {workspace.story.status === "complete" ? "مكتملة" : "مسودة"}،{" "}
              {workspace.version.storyConfig.pageCount} صفحة
            </span>
          </button>
        ))}
      </div>
      {!projects.length ? (
        <p className="project-rail-empty">لا توجد مشاريع بعد.</p>
      ) : null}
    </aside>
  );
}

function AuthoringContent({
  state,
  client,
}: {
  state: ProjectsState;
  client: ApiClient;
}) {
  if (state.creating || !state.workspace)
    return (
      <ProjectCreateForm
        characters={state.characters}
        looks={state.looks}
        templates={state.templates.filter((item) => item.status === "active")}
        busy={state.busy}
        onCreate={state.createProject}
        onCancel={
          state.projects.length ? () => state.setCreating(false) : undefined
        }
      />
    );
  return (
    <ProjectWorkspaceView
      client={client}
      workspace={state.workspace}
      templates={state.templates}
      onWorkspace={state.setWorkspace}
      onTemplates={state.setTemplates}
    />
  );
}

function useProjectsState(client: ApiClient) {
  const state = useProjectStateValues();
  const reload = useProjectsReload(client, state);
  useInitialProjectsLoad(
    client,
    state.setLibrary,
    state.setTemplates,
    state.setLoading,
    state.setError,
  );
  useFamilyProjectsLoad(
    client,
    state.familyId,
    state.setProjects,
    state.setWorkspace,
    state.setCreating,
    state.setError,
  );
  const characters = useMemo(
    () =>
      state.library?.characters.filter(
        (item) => item.familyId === state.familyId,
      ) ?? [],
    [state.library, state.familyId],
  );
  const looks = useMemo(
    () =>
      state.library?.looks.filter((look) =>
        characters.some((character) => character.id === look.characterId),
      ) ?? [],
    [state.library, characters],
  );
  const actions = projectActions(client, state);
  return {
    ...state,
    ...actions,
    setWorkspace: actions.updateWorkspace,
    reload,
    characters,
    looks,
  };
}

function useProjectStateValues() {
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [templates, setTemplates] = useState<AuthoringTemplateRecord[]>([]);
  const [projects, setProjects] = useState<AuthoringProjectWorkspace[]>([]);
  const [familyId, setFamilyId] = useState("");
  const [workspace, setWorkspace] = useState<AuthoringProjectWorkspace | null>(
    null,
  );
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return {
    library,
    setLibrary,
    templates,
    setTemplates,
    projects,
    setProjects,
    familyId,
    setFamilyId,
    workspace,
    setWorkspace,
    creating,
    setCreating,
    loading,
    setLoading,
    busy,
    setBusy,
    error,
    setError,
  };
}

type ProjectStateValues = ReturnType<typeof useProjectStateValues>;

function useProjectsReload(client: ApiClient, state: ProjectStateValues) {
  const { setLibrary, setTemplates, setError, setLoading } = state;
  return useCallback(async () => {
    try {
      const [nextLibrary, nextTemplates] = await Promise.all([
        client.library(),
        client.authoringTemplates(true),
      ]);
      setLibrary(nextLibrary);
      setTemplates(nextTemplates);
      setError("");
    } catch (reason) {
      setError(authoringError(reason));
    } finally {
      setLoading(false);
    }
  }, [client, setError, setLibrary, setLoading, setTemplates]);
}

function projectActions(client: ApiClient, state: ProjectStateValues) {
  async function createProject(input: AuthoringProjectInput) {
    state.setBusy(true);
    try {
      const created = await client.createAuthoringProject(
        state.familyId,
        input,
      );
      state.setProjects((current) => [...current, created]);
      state.setWorkspace(created);
      state.setCreating(false);
      state.setError("");
    } catch (reason) {
      state.setError(authoringError(reason));
    } finally {
      state.setBusy(false);
    }
  }
  function selectFamily(id: string) {
    state.setFamilyId(id);
    state.setProjects([]);
    state.setWorkspace(null);
    state.setCreating(false);
  }
  function selectProject(id: string) {
    state.setWorkspace(
      state.projects.find((item) => item.project.id === id) ?? null,
    );
    state.setCreating(false);
  }
  function updateWorkspace(next: AuthoringProjectWorkspace) {
    state.setWorkspace(next);
    state.setProjects((current) =>
      current.map((item) =>
        item.project.id === next.project.id ? next : item,
      ),
    );
  }
  return { createProject, selectFamily, selectProject, updateWorkspace };
}

type ProjectsState = ReturnType<typeof useProjectsState>;

function useInitialProjectsLoad(
  client: ApiClient,
  setLibrary: (value: LibrarySnapshot) => void,
  setTemplates: (value: AuthoringTemplateRecord[]) => void,
  setLoading: (value: boolean) => void,
  setError: (value: string) => void,
) {
  useEffect(() => {
    let active = true;
    void Promise.all([client.library(), client.authoringTemplates(true)])
      .then(([library, templates]) => {
        if (!active) return;
        setLibrary(library);
        setTemplates(templates);
      })
      .catch((reason: unknown) => {
        if (active) setError(authoringError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, setError, setLibrary, setLoading, setTemplates]);
}

function useFamilyProjectsLoad(
  client: ApiClient,
  familyId: string,
  setProjects: (items: AuthoringProjectWorkspace[]) => void,
  setWorkspace: (item: AuthoringProjectWorkspace | null) => void,
  setCreating: (value: boolean) => void,
  setError: (value: string) => void,
) {
  useEffect(() => {
    if (!familyId) return;
    let active = true;
    void client
      .authoringProjects(familyId)
      .then((items) => {
        if (!active) return;
        setProjects(items);
        setWorkspace(items[0] ?? null);
        setCreating(items.length === 0);
        setError("");
      })
      .catch((reason: unknown) => {
        if (active) setError(authoringError(reason));
      });
    return () => {
      active = false;
    };
  }, [client, familyId, setCreating, setError, setProjects, setWorkspace]);
}

function ProjectsEmpty() {
  return (
    <section className="authoring-empty">
      <div className="empty-mark" aria-hidden="true">
        ح
      </div>
      <h2>اختر عائلة جاهزة</h2>
      <p>أنشئ العميل والعائلة والطفل المحور في مكتبة العائلات أولًا.</p>
    </section>
  );
}
function ProjectsLoading() {
  return (
    <main className="view center-state" id="main-content" aria-busy="true">
      <h1>نفتح دفاتر الحكايات</h1>
      <div className="skeleton-line" />
    </main>
  );
}
function ProjectsFailure({ message }: { message: string }) {
  return (
    <main className="view center-state center-state--error" id="main-content">
      <h1>تعذّر فتح المشاريع</h1>
      <p>{message}</p>
    </main>
  );
}
function authoringError(reason: unknown) {
  return reason instanceof ApiError ? reason.code : "تعذّر إكمال الطلب المحلي.";
}
