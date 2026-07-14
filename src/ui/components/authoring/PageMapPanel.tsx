import type {
  AuthoringPageCount,
  AuthoringProjectWorkspace,
  PageCountPlan,
} from "../../types";

export function PageMapPanel({
  workspace,
  selectedIndex,
  plan,
  busy,
  onSelect,
  onPreflight,
  onConfirm,
  onCancel,
}: {
  workspace: AuthoringProjectWorkspace;
  selectedIndex: number;
  plan: PageCountPlan | null;
  busy: boolean;
  onSelect: (index: number) => void;
  onPreflight: (to: AuthoringPageCount) => Promise<void>;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const target = workspace.version.storyConfig.pageCount === 16 ? 24 : 16;
  return (
    <section className="page-map-panel" aria-labelledby="page-map-title">
      <PageMapHeading
        count={workspace.pageMap.length}
        target={target}
        busy={busy}
        onPreflight={onPreflight}
      />
      <PageMapTiles
        workspace={workspace}
        selectedIndex={selectedIndex}
        onSelect={onSelect}
      />
      {plan ? (
        <PageCountPreflight
          plan={plan}
          busy={busy}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : null}
    </section>
  );
}

function PageMapHeading({
  count,
  target,
  busy,
  onPreflight,
}: {
  count: number;
  target: AuthoringPageCount;
  busy: boolean;
  onPreflight: (to: AuthoringPageCount) => Promise<void>;
}) {
  return (
    <header className="authoring-section-heading">
      <div>
        <p className="eyebrow">الخريطة الداخلية</p>
        <h3 id="page-map-title">{count} صفحة</h3>
      </div>
      <button
        className="button button--secondary"
        type="button"
        disabled={busy}
        onClick={() => void onPreflight(target)}
      >
        تغيير إلى {target} صفحة
      </button>
    </header>
  );
}

function PageMapTiles({
  workspace,
  selectedIndex,
  onSelect,
}: {
  workspace: AuthoringProjectWorkspace;
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="page-map" aria-label="صفحات الكتاب بالترتيب">
      {workspace.pageMap.map((page) => (
        <li key={page.pageNumber}>
          {page.kind === "story" ? (
            <StoryPageTile
              workspace={workspace}
              page={page}
              selectedIndex={selectedIndex}
              onSelect={onSelect}
            />
          ) : (
            <div className="page-tile page-tile--fixed">
              <span>{page.pageNumber}</span>
              <b>{pageLabel(page.kind)}</b>
              <small>صفحة ثابتة</small>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function StoryPageTile({
  workspace,
  page,
  selectedIndex,
  onSelect,
}: {
  workspace: AuthoringProjectWorkspace;
  page: AuthoringProjectWorkspace["pageMap"][number];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const index = page.storyPageIndex ?? 1;
  return (
    <button
      className={
        index === selectedIndex ? "page-tile page-tile--active" : "page-tile"
      }
      type="button"
      onClick={() => onSelect(index)}
      aria-current={index === selectedIndex ? "step" : undefined}
    >
      <span>{page.pageNumber}</span>
      <b>مشهد {index}</b>
      <small>{sceneState(workspace, index)}</small>
    </button>
  );
}

function PageCountPreflight({
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: PageCountPlan;
  busy: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <section
      className="page-count-preflight"
      aria-labelledby="page-count-title"
    >
      <div>
        <p className="eyebrow">لا تغيير قبل التأكيد</p>
        <h4 id="page-count-title">
          خطة {plan.input.from} ← {plan.input.to} صفحة
        </h4>
      </div>
      <PreflightOperations plan={plan} />
      <PreflightActions busy={busy} onConfirm={onConfirm} onCancel={onCancel} />
    </section>
  );
}

function PreflightOperations({ plan }: { plan: PageCountPlan }) {
  return (
    <ol>
      {plan.operations.map((operation, index) => (
        <li key={`${operation.type}-${index}`}>
          <b>{operationLabel(operation.type)}</b>
          <span>
            {operation.targetStoryPageIndex
              ? `المشهد ${operation.targetStoryPageIndex}`
              : "بلا هدف"}
          </span>
          <small>
            {operation.sourceSceneVersionIds.length
              ? `${operation.sourceSceneVersionIds.length} مصدر`
              : "مشهد جديد"}
          </small>
        </li>
      ))}
    </ol>
  );
}

function PreflightActions({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <div className="section-actions">
      <button
        className="button button--primary"
        type="button"
        disabled={busy}
        onClick={() => void onConfirm()}
      >
        تأكيد الخطة وإنشاء نسخة
      </button>
      <button
        className="button button--secondary"
        type="button"
        onClick={onCancel}
      >
        إلغاء
      </button>
    </div>
  );
}

function sceneState(workspace: AuthoringProjectWorkspace, index: number) {
  return workspace.scenes.find((item) => item.scene.storyPageIndex === index)
    ?.version.needsAuthoring
    ? "يحتاج كتابة"
    : "مكتمل";
}

function pageLabel(kind: AuthoringProjectWorkspace["pageMap"][number]["kind"]) {
  return {
    title: "العنوان",
    dedication: "الإهداء",
    story: "مشهد",
    farewell: "الوداع",
    brand: "العلامة",
  }[kind];
}

function operationLabel(type: PageCountPlan["operations"][number]["type"]) {
  return { retain: "احتفاظ", add: "إضافة", merge: "دمج", remove: "إزالة" }[
    type
  ];
}
