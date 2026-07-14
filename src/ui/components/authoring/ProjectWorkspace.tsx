import { useEffect, useState } from "react";

import type { ApiClient } from "../../api";
import type {
  AuthoringProjectWorkspace,
  AuthoringTemplateRecord,
  MentionCandidate,
  PageCountPlan,
} from "../../types";
import {
  AppearanceOverridePanel,
  type OverrideInput,
} from "./AppearanceOverridePanel";
import { PageMapPanel } from "./PageMapPanel";
import { ProjectConfigurationPanel } from "./ProjectConfigurationPanel";
import { SceneEditor } from "./SceneEditor";
import { TemplateLibrary } from "./TemplateLibrary";

export function ProjectWorkspaceView({
  client,
  workspace,
  templates,
  onWorkspace,
  onTemplates,
}: {
  client: ApiClient;
  workspace: AuthoringProjectWorkspace;
  templates: AuthoringTemplateRecord[];
  onWorkspace: (workspace: AuthoringProjectWorkspace) => void;
  onTemplates: (templates: AuthoringTemplateRecord[]) => void;
}) {
  const state = useWorkspaceViewState(client, workspace);
  const actions = workspaceActions({
    client,
    workspace,
    plan: state.plan,
    setBusy: state.setBusy,
    setError: state.setError,
    onWorkspace,
    setPlan: state.setPlan,
  });
  return (
    <WorkspaceBody
      client={client}
      workspace={workspace}
      templates={templates}
      onTemplates={onTemplates}
      state={state}
      actions={actions}
    />
  );
}

function useWorkspaceViewState(
  client: ApiClient,
  workspace: AuthoringProjectWorkspace,
) {
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [plan, setPlan] = useState<PageCountPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void client
      .authoringMentions(workspace.project.familyId, workspace.project.id)
      .then(setCandidates);
  }, [
    client,
    workspace.project.familyId,
    workspace.project.id,
    workspace.version.id,
  ]);
  const scene =
    workspace.scenes.find(
      (item) => item.scene.storyPageIndex === selectedIndex,
    ) ?? workspace.scenes[0];
  return {
    selectedIndex,
    setSelectedIndex,
    candidates,
    plan,
    setPlan,
    busy,
    setBusy,
    error,
    setError,
    scene,
  };
}

type WorkspaceViewState = ReturnType<typeof useWorkspaceViewState>;
type WorkspaceActions = ReturnType<typeof workspaceActions>;

function WorkspaceBody({
  client,
  workspace,
  templates,
  onTemplates,
  state,
  actions,
}: {
  client: ApiClient;
  workspace: AuthoringProjectWorkspace;
  templates: AuthoringTemplateRecord[];
  onTemplates: (templates: AuthoringTemplateRecord[]) => void;
  state: WorkspaceViewState;
  actions: WorkspaceActions;
}) {
  return (
    <div className="project-workspace">
      <WorkspaceLead workspace={workspace} error={state.error} />
      <WorkspaceConfigurationPanels
        client={client}
        workspace={workspace}
        candidates={state.candidates}
        busy={state.busy}
        setBusy={state.setBusy}
        setError={state.setError}
        onWorkspace={actions.onWorkspace}
      />
      <PageMapPanel
        workspace={workspace}
        selectedIndex={state.selectedIndex}
        plan={state.plan}
        busy={state.busy}
        onSelect={state.setSelectedIndex}
        onPreflight={actions.preflight}
        onConfirm={actions.confirm}
        onCancel={() => state.setPlan(null)}
      />
      <WorkspaceScene state={state} actions={actions} />
      <WorkspaceTemplateLibrary
        client={client}
        workspace={workspace}
        templates={templates}
        busy={state.busy}
        setBusy={state.setBusy}
        setError={state.setError}
        onTemplates={onTemplates}
      />
    </div>
  );
}

function WorkspaceLead({
  workspace,
  error,
}: {
  workspace: AuthoringProjectWorkspace;
  error: string;
}) {
  return (
    <>
      <WorkspaceSummary workspace={workspace} />
      <WorkspaceError message={error} />
    </>
  );
}

function WorkspaceConfigurationPanels({
  client,
  workspace,
  candidates,
  busy,
  setBusy,
  setError,
  onWorkspace,
}: {
  client: ApiClient;
  workspace: AuthoringProjectWorkspace;
  candidates: MentionCandidate[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  onWorkspace: (workspace: AuthoringProjectWorkspace) => void;
}) {
  const shared = { client, workspace, busy, setBusy, setError, onWorkspace };
  return (
    <>
      <WorkspaceConfiguration {...shared} />
      <WorkspaceAppearanceOverride {...shared} candidates={candidates} />
    </>
  );
}

function WorkspaceConfiguration({
  client,
  workspace,
  busy,
  setBusy,
  setError,
  onWorkspace,
}: {
  client: ApiClient;
  workspace: AuthoringProjectWorkspace;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  onWorkspace: (workspace: AuthoringProjectWorkspace) => void;
}) {
  return (
    <ProjectConfigurationPanel
      workspace={workspace}
      busy={busy}
      onSave={async (input) => {
        setBusy(true);
        setError("");
        try {
          onWorkspace(
            await client.updateAuthoringProject(
              workspace.project.familyId,
              workspace.project.id,
              { expectedVersionId: workspace.version.id, input },
            ),
          );
        } catch (reason) {
          setError(
            reason instanceof Error ? reason.message : "تعذّر حفظ الإعداد.",
          );
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

function WorkspaceScene({
  state,
  actions,
}: {
  state: WorkspaceViewState;
  actions: WorkspaceActions;
}) {
  const scene = state.scene;
  return scene ? (
    <SceneEditor
      key={scene.version.id}
      scene={scene}
      candidates={state.candidates}
      busy={state.busy}
      onSave={(content) => actions.saveScene(scene, content)}
    />
  ) : null;
}

function WorkspaceAppearanceOverride({
  client,
  workspace,
  candidates,
  busy,
  setBusy,
  setError,
  onWorkspace,
}: {
  client: ApiClient;
  workspace: AuthoringProjectWorkspace;
  candidates: MentionCandidate[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  onWorkspace: (workspace: AuthoringProjectWorkspace) => void;
}) {
  async function save(input: OverrideInput) {
    setBusy(true);
    setError("");
    try {
      await client.appendAuthoringOverride(
        workspace.project.familyId,
        workspace.project.id,
        { ...input, expectedProjectVersionId: workspace.version.id },
      );
      onWorkspace(
        await client.authoringProject(
          workspace.project.familyId,
          workspace.project.id,
        ),
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "تعذّر حفظ مظهر المشروع.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <AppearanceOverridePanel
      workspace={workspace}
      candidates={candidates}
      busy={busy}
      onSave={save}
    />
  );
}

function WorkspaceError({ message }: { message: string }) {
  return message ? (
    <p className="authoring-error" role="alert">
      {message}
    </p>
  ) : null;
}

function WorkspaceTemplateLibrary({
  client,
  workspace,
  templates,
  busy,
  setBusy,
  setError,
  onTemplates,
}: {
  client: ApiClient;
  workspace: AuthoringProjectWorkspace;
  templates: AuthoringTemplateRecord[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  onTemplates: (templates: AuthoringTemplateRecord[]) => void;
}) {
  const run = (operation: () => Promise<unknown>) =>
    runTemplateOperation(client, operation, setBusy, setError, onTemplates);
  const actions = templateLibraryActions(client, workspace, run);
  return (
    <TemplateLibrary
      templates={templates}
      busy={busy}
      canExtract={workspace.story.status === "complete"}
      {...actions}
    />
  );
}

function templateLibraryActions(
  client: ApiClient,
  workspace: AuthoringProjectWorkspace,
  run: (operation: () => Promise<unknown>) => Promise<void>,
) {
  return {
    onStatus: (
      template: AuthoringTemplateRecord,
      status: AuthoringTemplateRecord["status"],
    ) =>
      run(() =>
        client.setAuthoringTemplateStatus(template.id, {
          expectedVersionId: template.version.id,
          expectedStatus: template.status,
          status,
        }),
      ),
    onDuplicate: (template: AuthoringTemplateRecord) =>
      run(() => client.duplicateAuthoringTemplate(template.id)),
    onCreate: (content: AuthoringTemplateRecord["version"]["content"]) =>
      run(() => client.createAuthoringTemplate(content)),
    onUpdate: (
      template: AuthoringTemplateRecord,
      content: AuthoringTemplateRecord["version"]["content"],
    ) =>
      run(() =>
        client.updateAuthoringTemplate(template.id, {
          expectedVersionId: template.version.id,
          content,
        }),
      ),
    onExtract: (name: string) =>
      run(() =>
        client.extractAuthoringTemplate(
          workspace.project.familyId,
          workspace.project.id,
          name,
        ),
      ),
  };
}

async function runTemplateOperation(
  client: ApiClient,
  operation: () => Promise<unknown>,
  setBusy: (value: boolean) => void,
  setError: (value: string) => void,
  onTemplates: (templates: AuthoringTemplateRecord[]) => void,
) {
  setBusy(true);
  setError("");
  try {
    await operation();
    onTemplates(await client.authoringTemplates(true));
  } catch (reason) {
    setError(reason instanceof Error ? reason.message : "تعذّرت عملية القالب.");
  } finally {
    setBusy(false);
  }
}

function WorkspaceSummary({
  workspace,
}: {
  workspace: AuthoringProjectWorkspace;
}) {
  const config = workspace.version.storyConfig;
  return (
    <section className="workspace-summary" aria-labelledby="workspace-title">
      <div>
        <p className="eyebrow">
          {workspace.story.status === "complete"
            ? "الحكاية مكتملة"
            : "مسودة قيد التأليف"}
        </p>
        <h2 id="workspace-title">{config.title}</h2>
        <p>
          {config.occasion || "من دون مناسبة مسجلة"}،{" "}
          {config.participants.length} شخصية، {config.pageCount} صفحة.
        </p>
      </div>
      <dl className="balance-meter">
        <div>
          <dt>السرد المقترح</dt>
          <dd>{config.narrationDialogueBalance.suggestedNarrationPercent}%</dd>
        </div>
        <div>
          <dt>السرد المختار</dt>
          <dd>{config.narrationDialogueBalance.selectedNarrationPercent}%</dd>
        </div>
      </dl>
    </section>
  );
}

interface WorkspaceActionInput {
  client: ApiClient;
  workspace: AuthoringProjectWorkspace;
  plan: PageCountPlan | null;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  onWorkspace: (workspace: AuthoringProjectWorkspace) => void;
  setPlan: (plan: PageCountPlan | null) => void;
}

function workspaceActions(input: WorkspaceActionInput) {
  const { client, workspace, plan, setBusy, setError, onWorkspace, setPlan } =
    input;
  const familyId = workspace.project.familyId;
  const run = workspaceRunner(setBusy, setError);
  return {
    onWorkspace,
    saveScene: async (
      scene: AuthoringProjectWorkspace["scenes"][number],
      content: AuthoringProjectWorkspace["scenes"][number]["version"]["content"],
    ) => {
      const next = await run(() =>
        client.updateAuthoringScene(
          familyId,
          workspace.project.id,
          scene.scene.storyPageIndex,
          {
            expectedStoryVersionId: workspace.storyVersion.id,
            expectedSceneVersionId: scene.version.id,
            content,
          },
        ),
      );
      if (next) onWorkspace(next);
    },
    preflight: async (to: 16 | 24) => {
      const next = await run(() =>
        client.preflightPageCount(familyId, workspace.project.id, to),
      );
      if (next) setPlan(next);
    },
    confirm: async () => {
      if (!plan) return;
      const next = await run(() =>
        client.confirmPageCount(familyId, workspace.project.id, plan),
      );
      if (next) {
        onWorkspace(next);
        setPlan(null);
      }
    },
  };
}

function workspaceRunner(
  setBusy: (value: boolean) => void,
  setError: (value: string) => void,
) {
  return async function run<T>(
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      return await operation();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "تعذّر إكمال الطلب المحلي.",
      );
    } finally {
      setBusy(false);
    }
  };
}
