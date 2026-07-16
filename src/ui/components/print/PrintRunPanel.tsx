import { useState } from "react";

import type { ApiClient } from "../../api";
import type { PrintProjectProjection } from "../../print-types";
import type { PrintState } from "../../views/use-print-state";

export function PrintRunPanel({
  client,
  state,
}: {
  client: ApiClient;
  state: PrintState;
}) {
  const snapshot = state.snapshot!;
  const run = snapshot.run;
  return (
    <section className="print-card print-run-panel" aria-labelledby="run-title">
      <header className="print-card-heading">
        <div>
          <p className="eyebrow">النسخة المعتمدة إلى ملفات المطبعة</p>
          <h2 id="run-title">الإنتاج والفحص</h2>
        </div>
        <RunState state={run?.state ?? "not_started"} />
      </header>
      <Readiness snapshot={snapshot} />
      {!run ? (
        <div className="print-start">
          <p>لن يبدأ أي رندر قبل اعتماد الكتاب وربط ملف طابعة مكتمل ومتوافق.</p>
          <button
            className="button button--accent"
            disabled={state.busy || !canStart(snapshot)}
            onClick={() => void state.start()}
          >
            {state.busy ? "جارٍ البدء…" : "إنتاج الداخل والغلاف"}
          </button>
        </div>
      ) : (
        <RunDetails client={client} state={state} snapshot={snapshot} />
      )}
    </section>
  );
}

function Readiness({ snapshot }: { snapshot: PrintProjectProjection }) {
  const facts = [
    [
      "اعتماد العميل",
      snapshot.project.currentContentApprovalId ? "✓ مثبت" : "! غير موجود",
    ],
    [
      "ملف الطابعة",
      snapshot.profileVersion?.readiness === "ready"
        ? "✓ مكتمل محليًا"
        : "! ناقص",
    ],
    [
      "توافق التكوين",
      snapshot.compatibility?.compatible
        ? "✓ مطابق للنسخة المعتمدة"
        : snapshot.profileVersion
          ? "! يلزم ترحيل التكوين وإعادة اعتماده"
          : "— لم يُفحص",
    ],
    ["مسار اللون", snapshot.profileVersion?.color.mode.toUpperCase() ?? "—"],
    [
      "الكعب",
      snapshot.profileVersion?.spine.widthMm
        ? `${snapshot.profileVersion.spine.widthMm} مم`
        : "! غير معروف",
    ],
  ];
  return (
    <div className="print-readiness" aria-label="جاهزية الطباعة">
      {facts.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function RunDetails({
  client,
  state,
  snapshot,
}: {
  client: ApiClient;
  state: PrintState;
  snapshot: PrintProjectProjection;
}) {
  const run = snapshot.run!;
  return (
    <div className="print-run-details">
      <RunLineage run={run} />
      {run.blockingReasons.length ? (
        <Notice
          tone="danger"
          title="الإنتاج متوقف"
          values={run.blockingReasons}
        />
      ) : null}
      {run.staleReasons.length ? (
        <Notice
          tone="warning"
          title="الملفات قديمة"
          values={run.staleReasons}
        />
      ) : null}
      <ArtifactGrid snapshot={snapshot} />
      {snapshot.report ? (
        <Preflight report={snapshot.report} />
      ) : (
        <p className="print-progress" role="status">
          المهام الدائمة تعمل محليًا. ستظهر قياسات الفحص هنا بعد اكتمال الملفين.
        </p>
      )}
      {run.state === "converted_proof_pending" ? (
        <ProofPanel client={client} state={state} snapshot={snapshot} />
      ) : null}
      {run.state === "deliverable" ? (
        <Downloads client={client} state={state} runId={run.id} />
      ) : null}
      <History snapshot={snapshot} />
    </div>
  );
}

function RunLineage({
  run,
}: {
  run: NonNullable<PrintProjectProjection["run"]>;
}) {
  return (
    <div className="print-lineage">
      <HashFact label="معرّف التشغيل" value={run.id} />
      <HashFact label="نسخة اعتماد العميل" value={run.approvalCycleId} />
      <HashFact label="نسخة المعاينة" value={run.previewOutputId} />
      <HashFact label="نسخة ملف الطابعة" value={run.printerProfileVersionId} />
      <HashFact label="اعتماد المحتوى" value={run.contentAuthorizationHash} />
      <HashFact label="بصمة الطابعة" value={run.printerProfileHash} />
    </div>
  );
}

function ArtifactGrid({ snapshot }: { snapshot: PrintProjectProjection }) {
  return (
    <div className="print-artifact-grid">
      {([snapshot.interior, snapshot.cover] as const).map((artifact, index) => (
        <article key={artifact?.id ?? index} className="print-artifact">
          <span aria-hidden="true">{artifact ? "✓" : "…"}</span>
          <div>
            <h3>{index === 0 ? "ملف الداخل" : "فردة الغلاف RTL"}</h3>
            {artifact ? (
              <>
                <p>
                  {artifact.renderFacts.pageCount} صفحة ·{" "}
                  {artifact.colorMode.toUpperCase()}
                </p>
                <p>
                  أقل دقة: {artifact.renderFacts.minimumImagePpi ?? "—"} PPI ·
                  علامة مائية: {artifact.renderFacts.watermarkCount}
                </p>
                <bdi>{shortHash(artifact.checksum)}</bdi>
              </>
            ) : (
              <p>في انتظار المنتج المحلي</p>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function Preflight({
  report,
}: {
  report: NonNullable<PrintProjectProjection["report"]>;
}) {
  const blanks = report.measurements.pageMap.filter(
    (page) => page.kind === "printer_blank",
  );
  return (
    <section className="print-preflight" aria-labelledby="preflight-title">
      <PreflightHeading report={report} blankCount={blanks.length} />
      <PreflightMeasurements report={report} />
      <PreflightFindings report={report} />
    </section>
  );
}

function PreflightHeading({
  report,
  blankCount,
}: {
  report: NonNullable<PrintProjectProjection["report"]>;
  blankCount: number;
}) {
  return (
    <div className="print-section-heading">
      <div>
        <p className="eyebrow">فحص ميكانيكي مغلق</p>
        <h3 id="preflight-title">
          {report.passed ? "✓ اجتاز الفحص" : "! توجد عيوب مانعة"}
        </h3>
      </div>
      <span>
        {report.measurements.colorMode.toUpperCase()} · {blankCount} صفحات فنية
      </span>
    </div>
  );
}

function PreflightMeasurements({
  report,
}: {
  report: NonNullable<PrintProjectProjection["report"]>;
}) {
  const measurements = report.measurements;
  return (
    <div className="print-measurements">
      <span>الداخل: {measurements.interior.pageCount} صفحة</span>
      <span>الغلاف: {measurements.cover.pageCount} صفحة</span>
      <span>أقل دقة: {measurements.interior.minimumImagePpi ?? "—"} PPI</span>
      <span>عرض الكعب: {measurements.coverSpread.spineWidthMm} مم</span>
      <span>
        علامات القص: {measurements.cropMarks.enabled ? "مفعلة" : "غير مفعلة"}
        {measurements.cropMarks.enabled
          ? ` · ${measurements.cropMarks.interiorSegmentCount}/${measurements.cropMarks.coverSegmentCount}`
          : ""}
      </span>
      <span>مصادر مثبتة: {measurements.sourceAssets.length}</span>
      <span>
        ICC:{" "}
        {measurements.iccChecksum
          ? shortHash(measurements.iccChecksum)
          : "غير مطلوب"}
      </span>
      <span>
        Output intent:{" "}
        {measurements.outputIntentMatches ? "مطابق" : "غير مطابق"}
      </span>
      <span>
        بصمة الداخل:{" "}
        <bdi>{shortHash(measurements.outputChecksums.interior)}</bdi>
      </span>
      <span>
        بصمة الغلاف: <bdi>{shortHash(measurements.outputChecksums.cover)}</bdi>
      </span>
    </div>
  );
}

function PreflightFindings({
  report,
}: {
  report: NonNullable<PrintProjectProjection["report"]>;
}) {
  if (!report.findings.length)
    return (
      <p className="print-clean">
        لا توجد ملاحظات مانعة. الخطوط والصناديق والدقة والعلامة المائية اجتازت
        السياسة.
      </p>
    );
  return (
    <div className="print-findings" role="list">
      {report.findings.map((finding, index) => (
        <div role="listitem" key={`${finding.code}:${index}`}>
          <strong>{finding.code}</strong>
          <span>
            {finding.artifact}
            {finding.page ? ` · صفحة ${finding.page}` : ""}
          </span>
          <span>
            المتوقع: {String(finding.expected)} — الفعلي:{" "}
            {String(finding.actual)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ProofPanel({
  client,
  state,
  snapshot,
}: {
  client: ApiClient;
  state: PrintState;
  snapshot: PrintProjectProjection;
}) {
  const [notes, setNotes] = useState("");
  const run = snapshot.run!;
  return (
    <section className="print-proof" aria-labelledby="proof-title">
      <ProofWarning />
      <ProofImages client={client} state={state} runId={run.id} />
      <label className="field">
        <span>ملاحظات الرفض (إلزامية عند الرفض)</span>
        <textarea
          value={notes}
          maxLength={1000}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <ProofActions state={state} notes={notes} />
    </section>
  );
}

function ProofWarning() {
  return (
    <div className="print-proof-warning">
      <span aria-hidden="true">!</span>
      <div>
        <h3 id="proof-title">بروفة ألوان CMYK — ليست ملفًا قابلًا للتسليم</h3>
        <p>
          راجع العينة المحولة المرتبطة بنفس ICC وبصمات الداخل والغلاف. لا يمكن
          لقائمة المهام اعتمادها.
        </p>
      </div>
    </div>
  );
}

function ProofImages({
  client,
  state,
  runId,
}: {
  client: ApiClient;
  state: PrintState;
  runId: string;
}) {
  return (
    <div className="print-proof-images">
      {(["interior", "cover"] as const).map((kind) => (
        <figure key={kind}>
          <img
            src={client.printProofUrl(state.familyId, runId, kind)}
            alt={
              kind === "interior"
                ? "عينة محلية من داخل الكتاب بعد تحويل CMYK"
                : "عينة محلية من فردة الغلاف بعد تحويل CMYK"
            }
          />
          <figcaption>
            {kind === "interior" ? "عينة الداخل" : "عينة الغلاف"}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function ProofActions({ state, notes }: { state: PrintState; notes: string }) {
  return (
    <div className="print-actions">
      <button
        className="button button--accent"
        disabled={state.busy}
        onClick={() => void state.proof("approved")}
      >
        اعتماد البروفة الدقيقة
      </button>
      <button
        className="button button--danger"
        disabled={state.busy || !notes.trim()}
        onClick={() => void state.proof("rejected", notes)}
      >
        رفض وطلب تعديل
      </button>
    </div>
  );
}

function Downloads({
  client,
  state,
  runId,
}: {
  client: ApiClient;
  state: PrintState;
  runId: string;
}) {
  return (
    <section className="print-downloads" aria-labelledby="downloads-title">
      <div>
        <p className="eyebrow">ملفات قابلة للتسليم</p>
        <h3 id="downloads-title">الداخل والغلاف اجتازا كل البوابات</h3>
        <p>
          الجاهزية هنا محلية. تحقّق من مواصفات المطبعة الفعلية وافحص بروفة ورقية
          قبل أول طلب تجاري.
        </p>
      </div>
      <div className="print-actions">
        <a
          className="button button--primary"
          href={client.printDownloadUrl(state.familyId, runId, "interior")}
        >
          تنزيل ملف الداخل
        </a>
        <a
          className="button button--primary"
          href={client.printDownloadUrl(state.familyId, runId, "cover")}
        >
          تنزيل فردة الغلاف
        </a>
      </div>
    </section>
  );
}

function History({ snapshot }: { snapshot: PrintProjectProjection }) {
  return (
    <details className="print-history">
      <summary>سجل تشغيلات الطباعة ({snapshot.history.length})</summary>
      <ol>
        {snapshot.history.map((item) => (
          <li key={item.id}>
            <bdi>{item.id}</bdi>
            <span>{stateLabel(item.state)}</span>
            <time>
              {new Date(item.createdAt).toLocaleString("ar-EG-u-nu-latn")}
            </time>
          </li>
        ))}
      </ol>
    </details>
  );
}
function HashFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <bdi title={value}>{shortHash(value)}</bdi>
    </div>
  );
}
function Notice({
  tone,
  title,
  values,
}: {
  tone: "danger" | "warning";
  title: string;
  values: string[];
}) {
  return (
    <div className={`print-notice print-notice--${tone}`} role="status">
      <strong>{title}</strong>
      <span>{values.join("، ")}</span>
    </div>
  );
}
function RunState({ state }: { state: string }) {
  return (
    <span
      className={`print-state print-state--${state === "deliverable" ? "ok" : state === "blocked" || state === "rejected" ? "danger" : "neutral"}`}
    >
      {stateLabel(state)}
    </span>
  );
}
function canStart(snapshot: PrintProjectProjection) {
  return Boolean(
    snapshot.project.currentContentApprovalId &&
    snapshot.profileVersion?.readiness === "ready",
  );
}
function shortHash(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
function stateLabel(value: string) {
  return (
    (
      {
        not_started: "لم يبدأ",
        queued: "في الصف",
        producing: "إنتاج الملفات",
        preflight_pending: "الفحص الميكانيكي",
        converted_proof_pending: "بانتظار بروفة اللون",
        deliverable: "جاهز للتسليم",
        blocked: "متوقف",
        stale: "قديم",
        rejected: "مرفوض",
      } as Record<string, string>
    )[value] ?? value
  );
}
