import { useState } from "react";

import type { ApiClient } from "../../api";
import type {
  CreativeFinding,
  CreativePage,
  CreativeReviewChecks,
  CreativeRun,
  CreativeSheet,
} from "../../creative-types";
import { FindingsPanel } from "./FindingsPanel";
import { PageReviewPanel, reviewLabel } from "./PageReviewPanel";

interface ReviewWorkspaceProps {
  client: ApiClient;
  familyId: string;
  run: CreativeRun;
  pages: CreativePage[];
  sheets: CreativeSheet[];
  findings: CreativeFinding[];
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
  onAcknowledge: (finding: CreativeFinding, note: string) => Promise<void>;
  onComplete: () => Promise<void>;
}

export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const storyPages = props.pages.filter((page) => page.kind === "story");
  const [selectedId, setSelectedId] = useState(storyPages[0]?.id ?? "");
  const selected =
    storyPages.find((page) => page.id === selectedId) ?? storyPages[0];
  const reviewed = storyPages.filter(
    (page) => page.reviewStatus === "approved",
  ).length;
  if (!selected)
    return <p className="creative-empty">الصفحات ستظهر بعد اكتمال التوليد.</p>;
  return (
    <section
      className="creative-section review-workspace"
      aria-labelledby="review-title"
    >
      <ReviewHeading reviewed={reviewed} total={storyPages.length} />
      <PageFilmstrip
        pages={storyPages}
        selectedId={selected.id}
        onSelect={setSelectedId}
      />
      <PageReviewPanel
        key={`${selected.id}:${selected.currentTextVersionId}:${selected.currentIllustrationVersionId}`}
        client={props.client}
        familyId={props.familyId}
        page={selected}
        sheets={props.sheets.filter((sheet) => sheet.status === "approved")}
        busy={props.busy || props.run.status !== "internal_review"}
        onReview={props.onReview}
        onLock={props.onLock}
        onRegenerate={props.onRegenerate}
        onRewriteText={props.onRewriteText}
        onRevert={props.onRevert}
        onRequestLayout={props.onRequestLayout}
      />
      <FindingsPanel
        findings={props.findings}
        busy={props.busy}
        onAcknowledge={props.onAcknowledge}
      />
      <ReviewFinish {...props} allReviewed={reviewed === storyPages.length} />
    </section>
  );
}

function ReviewHeading({
  reviewed,
  total,
}: {
  reviewed: number;
  total: number;
}) {
  return (
    <div className="creative-section-heading review-heading">
      <div>
        <p className="eyebrow">مراجعة بشرية إلزامية</p>
        <h2 id="review-title">مراجعة الصفحات</h2>
      </div>
      <div
        className="review-count"
        aria-label={`${reviewed} من ${total} صفحة معتمدة`}
      >
        <strong>{reviewed}</strong>
        <span>من {total}</span>
      </div>
    </div>
  );
}

function PageFilmstrip({
  pages,
  selectedId,
  onSelect,
}: {
  pages: CreativePage[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="page-filmstrip" aria-label="صفحات الحكاية">
      {pages.map((page) => (
        <button
          type="button"
          key={page.id}
          className={
            page.id === selectedId
              ? "page-frame page-frame--active"
              : "page-frame"
          }
          onClick={() => onSelect(page.id)}
          aria-label={`صفحة الحكاية ${page.storyPageIndex}، ${reviewLabel(page)}`}
          aria-current={page.id === selectedId ? "true" : undefined}
        >
          <span>{page.storyPageIndex}</span>
          <small>
            {page.staleState !== "current"
              ? "قديم"
              : page.reviewStatus === "approved"
                ? "تم"
                : "راجع"}
          </small>
        </button>
      ))}
    </div>
  );
}

function ReviewFinish({
  run,
  findings,
  busy,
  allReviewed,
  onComplete,
}: ReviewWorkspaceProps & { allReviewed: boolean }) {
  const blocked = findings.some(
    (item) => item.severity === "block" && !item.acknowledged,
  );
  return (
    <div className="review-finish">
      <div>
        <strong>
          {run.status === "complete"
            ? "اكتملت المراجعة"
            : "بوابة المراجعة الداخلية"}
        </strong>
        <p>
          {blocked
            ? "أقرّ الملاحظة المانعة بسبب واضح قبل إغلاق البوابة."
            : allReviewed
              ? "كل الصفحات معتمدة ويمكن إغلاق البوابة."
              : "اعتمد كل صفحة أولًا. القفل اختياري بعد الاعتماد."}
        </p>
      </div>
      <button
        className="button button--accent"
        type="button"
        disabled={
          busy || !allReviewed || run.status !== "internal_review" || blocked
        }
        onClick={() => void onComplete()}
      >
        إكمال المراجعة الداخلية
      </button>
    </div>
  );
}
