import { useEffect, useState } from "react";

import type { ApiClient } from "../../api";
import type {
  CreativePage,
  CreativePageHistory,
  CreativeReviewChecks,
  CreativeSheet,
} from "../../creative-types";
import { ConsistencyCompare } from "./ConsistencyCompare";
import { PageEditTools } from "./PageEditTools";
import { PageVersionHistory } from "./PageVersionHistory";
import { emptyChecks, groupLabel, reviewChecks } from "./review-config";

interface PageReviewPanelProps {
  client: ApiClient;
  familyId: string;
  page: CreativePage;
  sheets: CreativeSheet[];
  busy: boolean;
  onReview: (
    page: CreativePage,
    checks: CreativeReviewChecks,
    notes: string,
  ) => Promise<void>;
  onLock: (page: CreativePage, action: "lock" | "unlock") => Promise<void>;
  onRegenerate: (page: CreativePage) => Promise<void>;
  onRewriteText: (
    page: CreativePage,
    narrative: string,
    dialogue: Array<{ speakerCharacterId: string; text: string }>,
  ) => Promise<void>;
  onRevert: (
    page: CreativePage,
    kind: "text" | "illustration",
    targetVersionId: string,
  ) => Promise<void>;
  onRequestLayout: (page: CreativePage) => Promise<void>;
}

export function PageReviewPanel(props: PageReviewPanelProps) {
  const history = usePageHistory(props);
  const [checks, setChecks] = useState<CreativeReviewChecks>(() =>
    emptyChecks(),
  );
  const [notes, setNotes] = useState("");
  const text = history?.text.find(
    (item) => item.id === props.page.currentTextVersionId,
  );
  return (
    <div className="page-inspector">
      <PageReviewMain
        {...props}
        history={history}
        narrative={text?.narrative ?? "جارٍ تحميل النص…"}
      />
      <ReviewChecklist
        page={props.page}
        busy={props.busy}
        checks={checks}
        notes={notes}
        onChecks={setChecks}
        onNotes={setNotes}
        onReview={props.onReview}
      />
    </div>
  );
}

function usePageHistory(props: PageReviewPanelProps) {
  const [history, setHistory] = useState<CreativePageHistory | null>(null);
  useEffect(() => {
    let active = true;
    void props.client
      .creativePageHistory(props.familyId, props.page.id)
      .then((value) => {
        if (active) setHistory(value);
      });
    return () => {
      active = false;
    };
  }, [
    props.client,
    props.familyId,
    props.page.id,
    props.page.revision,
    props.page.currentTextVersionId,
    props.page.currentIllustrationVersionId,
  ]);
  return history;
}

function PageReviewMain({
  history,
  narrative,
  ...props
}: PageReviewPanelProps & {
  history: CreativePageHistory | null;
  narrative: string;
}) {
  return (
    <div className="page-review-main">
      <PageProof {...props} narrative={narrative} />
      <ConsistencyCompare
        client={props.client}
        familyId={props.familyId}
        page={props.page}
        sheets={props.sheets}
      />
      {history ? (
        <>
          <PageEditTools
            page={props.page}
            history={history}
            busy={props.busy}
            onRewriteText={props.onRewriteText}
            onRequestLayout={props.onRequestLayout}
          />
          <PageVersionHistory
            client={props.client}
            familyId={props.familyId}
            page={props.page}
            history={history}
            busy={props.busy}
            onRevert={props.onRevert}
          />
        </>
      ) : null}
    </div>
  );
}

function PageProof({
  client,
  familyId,
  page,
  narrative,
  busy,
  onLock,
  onRegenerate,
}: PageReviewPanelProps & { narrative: string }) {
  return (
    <div className="page-proof">
      <div className="page-proof__image">
        {page.currentIllustrationVersionId ? (
          <img
            src={client.creativeIllustrationUrl(
              familyId,
              page.id,
              page.currentIllustrationVersionId,
            )}
            alt={`الرسم الحالي لصفحة ${page.storyPageIndex}`}
          />
        ) : (
          <div className="image-placeholder">الرسم لم يكتمل بعد</div>
        )}
      </div>
      <div className="page-proof__copy">
        <div className="proof-title">
          <h3>صفحة {page.storyPageIndex}</h3>
          <PageState page={page} />
        </div>
        <p className="story-copy">{narrative}</p>
        <VersionPair page={page} />
        <ProofActions
          page={page}
          busy={busy}
          onLock={onLock}
          onRegenerate={onRegenerate}
        />
      </div>
    </div>
  );
}

function VersionPair({ page }: { page: CreativePage }) {
  return (
    <dl className="version-pair">
      <div>
        <dt>النص</dt>
        <dd>
          <bdi>{shortId(page.currentTextVersionId)}</bdi>
        </dd>
      </div>
      <div>
        <dt>الرسم</dt>
        <dd>
          <bdi>{shortId(page.currentIllustrationVersionId)}</bdi>
        </dd>
      </div>
    </dl>
  );
}

function ProofActions({
  page,
  busy,
  onLock,
  onRegenerate,
}: {
  page: CreativePage;
  busy: boolean;
  onLock: PageReviewPanelProps["onLock"];
  onRegenerate: PageReviewPanelProps["onRegenerate"];
}) {
  return (
    <div className="proof-actions">
      <button
        type="button"
        className="button button--secondary"
        disabled={busy || page.locked || !page.currentIllustrationVersionId}
        onClick={() => void onRegenerate(page)}
      >
        إعادة الرسم لهذه الصفحة فقط
      </button>
      <button
        type="button"
        className="button button--secondary"
        disabled={busy || (page.reviewStatus !== "approved" && !page.locked)}
        onClick={() => void onLock(page, page.locked ? "unlock" : "lock")}
      >
        {page.locked ? "فك القفل" : "قفل الصفحة"}
      </button>
    </div>
  );
}

function ReviewChecklist({
  page,
  busy,
  checks,
  notes,
  onChecks,
  onNotes,
  onReview,
}: {
  page: CreativePage;
  busy: boolean;
  checks: CreativeReviewChecks;
  notes: string;
  onChecks: (value: CreativeReviewChecks) => void;
  onNotes: (value: string) => void;
  onReview: PageReviewPanelProps["onReview"];
}) {
  return (
    <form
      className="review-checklist"
      onSubmit={(event) => {
        event.preventDefault();
        void onReview(page, checks, notes);
      }}
    >
      <ChecklistToolbar onSelectAll={() => onChecks(emptyChecks(true))} />
      <CheckGroups checks={checks} onChecks={onChecks} />
      <label className="field">
        <span>ملاحظات المراجعة</span>
        <textarea
          value={notes}
          onChange={(event) => onNotes(event.target.value)}
          rows={3}
        />
      </label>
      <button
        className="button button--primary"
        type="submit"
        disabled={busy || page.locked || !Object.values(checks).every(Boolean)}
      >
        اعتماد الصفحة الحالية
      </button>
    </form>
  );
}

function ChecklistToolbar({ onSelectAll }: { onSelectAll: () => void }) {
  return (
    <div className="checklist-toolbar">
      <h3>قائمة الاعتماد</h3>
      <button type="button" className="text-button" onClick={onSelectAll}>
        تحديد الكل بعد الفحص
      </button>
    </div>
  );
}

function CheckGroups({
  checks,
  onChecks,
}: {
  checks: CreativeReviewChecks;
  onChecks: (value: CreativeReviewChecks) => void;
}) {
  return (
    <>
      {(["identity", "story", "safety"] as const).map((group) => (
        <fieldset key={group}>
          <legend>{groupLabel(group)}</legend>
          <div className="check-grid">
            {reviewChecks
              .filter((item) => item.group === group)
              .map((item) => (
                <label key={item.key} className="review-check">
                  <input
                    type="checkbox"
                    checked={checks[item.key]}
                    onChange={(event) =>
                      onChecks({ ...checks, [item.key]: event.target.checked })
                    }
                  />
                  <span>{item.label}</span>
                </label>
              ))}
          </div>
        </fieldset>
      ))}
    </>
  );
}

function PageState({ page }: { page: CreativePage }) {
  return (
    <span className={`creative-status creative-status--${page.reviewStatus}`}>
      {reviewLabel(page)}
    </span>
  );
}

export function reviewLabel(page: CreativePage) {
  if (page.staleState !== "current")
    return page.locked ? "مقفلة وقديمة" : "تحتاج تحديثًا";
  if (page.reviewStatus === "approved")
    return page.locked ? "معتمدة ومقفلة" : "معتمدة";
  return page.reviewStatus === "flagged" ? "تحتاج مراجعة" : "غير مراجعة";
}

function shortId(value: string | null) {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "غير متاح";
}
