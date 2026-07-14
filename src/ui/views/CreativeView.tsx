import type { ApiClient } from "../api";
import { PolicyConfirmation } from "../components/creative/PolicyConfirmation";
import { ReviewWorkspace } from "../components/creative/ReviewWorkspace";
import { SheetLane } from "../components/creative/SheetLane";
import type {
  AuthoringProjectWorkspace,
  CreativeRun,
  LibrarySnapshot,
} from "../types";
import { useCreativeState } from "./use-creative-state";

interface CreativeContextProps {
  library: LibrarySnapshot | null;
  projects: AuthoringProjectWorkspace[];
  familyId: string;
  projectId: string;
  onFamily: (id: string) => void;
  onProject: (id: string) => void;
}

interface RunRailProps {
  workspace: AuthoringProjectWorkspace;
  run: CreativeRun | null;
  sheetsReady: boolean;
  busy: boolean;
  onStart: () => void;
}

export function CreativeView({ client }: { client: ApiClient }) {
  const state = useCreativeState(client);
  return (
    <main className="view view--creative" id="main-content">
      <header className="view-header view-header--with-action creative-view-header">
        <div>
          <p className="eyebrow">من الهوية إلى الصفحة المعتمدة</p>
          <h1>الإبداع والمراجعة</h1>
          <p>
            اعتماد أوراق الشخصيات، متابعة مراحل التوليد، ثم فحص كل صفحة على حدة.
          </p>
        </div>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => void state.reload()}
          disabled={state.loading}
        >
          تحديث الحالة
        </button>
      </header>
      {state.error ? (
        <p className="creative-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <CreativeContext
        library={state.library}
        projects={state.projects}
        familyId={state.familyId}
        projectId={state.workspace?.project.id ?? ""}
        onFamily={state.selectFamily}
        onProject={state.selectProject}
      />
      {state.policyChallenge ? (
        <PolicyConfirmation
          code={state.policyChallenge.code}
          details={state.policyChallenge.details}
          onConfirm={state.policyChallenge.confirm}
          onDismiss={state.dismissPolicyChallenge}
        />
      ) : null}
      <CreativeBody client={client} state={state} />
    </main>
  );
}

function CreativeBody({
  client,
  state,
}: {
  client: ApiClient;
  state: ReturnType<typeof useCreativeState>;
}) {
  if (state.loading) return <CreativeLoading />;
  if (!state.workspace || !state.snapshot || !state.library)
    return <CreativeEmpty familyId={state.familyId} />;
  const showReview =
    state.run &&
    state.snapshot.pages.some((page) => page.currentIllustrationVersionId);
  return (
    <>
      <SheetLane
        client={client}
        familyId={state.familyId}
        workspace={state.workspace}
        library={state.library}
        sheets={state.snapshot.sheets}
        intents={state.snapshot.sheetIntents}
        busyId={state.busyId}
        onGenerate={(id) => void state.generateSheet(id)}
        onApprove={(sheet, intent, notes) =>
          void state.approveSheet(sheet, intent, notes)
        }
        onRequestChanges={(sheet, intent, notes) =>
          void state.requestSheetChanges(sheet, intent, notes)
        }
      />
      <RunRail
        workspace={state.workspace}
        run={state.run}
        sheetsReady={state.sheetsReady}
        busy={state.busyId === "run"}
        onStart={() => void state.startRun()}
      />
      {showReview ? <CreativeReview client={client} state={state} /> : null}
    </>
  );
}

function CreativeReview({
  client,
  state,
}: {
  client: ApiClient;
  state: ReturnType<typeof useCreativeState>;
}) {
  if (!state.run || !state.snapshot) return null;
  const busy =
    state.busyId.startsWith("page:") ||
    state.busyId.startsWith("finding:") ||
    state.busyId === "complete";
  return (
    <ReviewWorkspace
      client={client}
      familyId={state.familyId}
      run={state.run}
      pages={state.snapshot.pages}
      sheets={state.snapshot.sheets}
      findings={state.findings}
      busy={busy}
      onReview={state.reviewPage}
      onLock={state.setPageLock}
      onRegenerate={state.regeneratePage}
      onRewriteText={state.rewritePageText}
      onRevert={state.revertPageVersion}
      onRequestLayout={state.requestPageLayout}
      onAcknowledge={state.acknowledgeFinding}
      onComplete={state.completeReview}
    />
  );
}

function CreativeContext({
  library,
  projects,
  familyId,
  projectId,
  onFamily,
  onProject,
}: CreativeContextProps) {
  return (
    <section className="creative-context-bar" aria-label="اختيار مشروع الإبداع">
      <label className="field">
        <span>العائلة</span>
        <select
          value={familyId}
          onChange={(event) => onFamily(event.target.value)}
        >
          <option value="">اختر عائلة</option>
          {library?.families
            .filter((family) => family.status === "active")
            .map((family) => (
              <option key={family.id} value={family.id}>
                {family.name}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        <span>المشروع</span>
        <select
          value={projectId}
          disabled={!familyId}
          onChange={(event) => onProject(event.target.value)}
        >
          <option value="">اختر مشروعًا</option>
          {projects.map((workspace) => (
            <option key={workspace.project.id} value={workspace.project.id}>
              {workspace.version.storyConfig.title}
            </option>
          ))}
        </select>
      </label>
      <p>
        التوليد يعمل في الخلفية. المراجعة والاعتماد هنا فقط، وليسا داخل قائمة
        المهام.
      </p>
    </section>
  );
}

function RunRail({ workspace, run, sheetsReady, busy, onStart }: RunRailProps) {
  const stages = run ? stageProjection(run) : [];
  const committed =
    run?.nodes.filter((node) => node.state === "committed").length ?? 0;
  return (
    <section className="creative-section run-rail" aria-labelledby="run-title">
      <RunHeading
        run={run}
        sheetsReady={sheetsReady}
        busy={busy}
        onStart={onStart}
      />
      {!sheetsReady ? (
        <p className="run-prerequisite">اعتمد ورقة كل شخصية أولًا.</p>
      ) : null}
      {run ? (
        <RunProgress run={run} committed={committed} stages={stages} />
      ) : (
        <p className="creative-empty">
          بعد اعتماد الشخصيات سيظهر هنا المسار الكامل قبل أول طلب للمزوّد.
        </p>
      )}
      <p className="run-caption">
        {workspace.version.storyConfig.pageCount} صفحة، منها{" "}
        {workspace.scenes.length} صفحة حكاية مستقلة.
      </p>
    </section>
  );
}

function RunHeading({
  run,
  sheetsReady,
  busy,
  onStart,
}: Omit<RunRailProps, "workspace">) {
  return (
    <div className="creative-section-heading">
      <div>
        <p className="eyebrow">المسار المتين</p>
        <h2 id="run-title">توليد الحكاية والرسوم</h2>
      </div>
      {!run || ["failed", "stale"].includes(run.status) ? (
        <button
          className="button button--primary"
          type="button"
          disabled={!sheetsReady || busy}
          onClick={onStart}
        >
          {busy ? "جارٍ إنشاء المسار…" : "بدء توليد الكتاب"}
        </button>
      ) : (
        <RunState run={run} />
      )}
    </div>
  );
}

function RunProgress({
  run,
  committed,
  stages,
}: {
  run: CreativeRun;
  committed: number;
  stages: ReturnType<typeof stageProjection>;
}) {
  const percent = Math.round((committed / run.nodes.length) * 100);
  return (
    <>
      <div
        className="run-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`${committed} من ${run.nodes.length} مرحلة مكتملة`}
      >
        <span style={{ inlineSize: `${percent}%` }} />
      </div>
      <ol className="stage-track">
        {stages.map((stage, index) => (
          <li
            key={stage.label}
            className={`stage-step stage-step--${stage.state}`}
          >
            <span>{index + 1}</span>
            <div>
              <strong>{stage.label}</strong>
              <small>{stage.note}</small>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function RunState({ run }: { run: CreativeRun }) {
  const labels: Record<CreativeRun["status"], string> = {
    planned: "مخطط",
    generating: "قيد التوليد",
    internal_review: "ينتظر المراجعة",
    complete: "مكتمل",
    failed: "توقف بخطأ",
    stale: "مدخلاته قديمة",
  };
  return (
    <span className={`run-state run-state--${run.status}`}>
      {labels[run.status]}
    </span>
  );
}

function stageProjection(run: CreativeRun) {
  const groups = [
    { label: "اعتماد الشخصيات", kinds: ["character_approval"] },
    { label: "خطة الحكاية", kinds: ["story_plan"] },
    { label: "النص والمشاهد", kinds: ["story_text", "scene_list"] },
    { label: "أوامر الصفحات", kinds: ["page_prompt"] },
    { label: "رسوم الصفحات", kinds: ["page_illustration"] },
    { label: "الفحص والمراجعة", kinds: ["review_findings", "internal_review"] },
  ];
  return groups.map((group) => {
    const nodes = run.nodes.filter((node) => group.kinds.includes(node.kind));
    const done = nodes.filter((node) => node.state === "committed").length;
    const failed = nodes.some((node) => node.state === "failed");
    return {
      label: group.label,
      state: failed
        ? "failed"
        : done === nodes.length
          ? "done"
          : nodes.some((node) => node.state === "materialized")
            ? "active"
            : "waiting",
      note: `${done} من ${nodes.length}`,
    };
  });
}

function CreativeLoading() {
  return (
    <section className="creative-loading" aria-busy="true">
      <div />
      <div />
      <div />
    </section>
  );
}

function CreativeEmpty({ familyId }: { familyId: string }) {
  return (
    <section className="creative-empty-state">
      <span aria-hidden="true">ح</span>
      <h2>{familyId ? "لا يوجد مشروع محدد" : "اختر عائلة ومشروعًا"}</h2>
      <p>
        {familyId
          ? "أنشئ مشروعًا في مساحة التأليف أو اختر واحدًا من القائمة."
          : "تبدأ ورشة الإبداع من مشروع مرتبط بعائلة وشخصيات ثابتة."}
      </p>
    </section>
  );
}
