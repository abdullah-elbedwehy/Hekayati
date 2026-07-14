import { useState } from "react";

import type { CreativeFinding } from "../../creative-types";

interface FindingsPanelProps {
  findings: CreativeFinding[];
  busy: boolean;
  onAcknowledge: (finding: CreativeFinding, note: string) => Promise<void>;
}

export function FindingsPanel({
  findings,
  busy,
  onAcknowledge,
}: FindingsPanelProps) {
  return (
    <section className="creative-findings" aria-labelledby="findings-title">
      <div>
        <p className="eyebrow">ملاحظات المساعد، غير مُلزمة</p>
        <h3 id="findings-title">نتيجة الفحص</h3>
      </div>
      {findings.length ? (
        <ul>
          {findings.map((finding) => (
            <FindingItem
              key={finding.key}
              finding={finding}
              busy={busy}
              onAcknowledge={onAcknowledge}
            />
          ))}
        </ul>
      ) : (
        <p>لا توجد ملاحظات آلية على النسخة الحالية.</p>
      )}
    </section>
  );
}

function FindingItem({
  finding,
  busy,
  onAcknowledge,
}: {
  finding: CreativeFinding;
  busy: boolean;
  onAcknowledge: FindingsPanelProps["onAcknowledge"];
}) {
  const [note, setNote] = useState("");
  return (
    <li>
      <div className="finding-copy">
        <span className={`finding-level finding-level--${finding.severity}`}>
          {finding.severity === "block"
            ? "مانع"
            : finding.severity === "warn"
              ? "تنبيه"
              : "ملاحظة"}
        </span>
        <span>{finding.note}</span>
      </div>
      {finding.acknowledged ? (
        <span className="finding-acknowledged">تم الإقرار بواسطة المشغّل</span>
      ) : finding.severity === "block" ? (
        <div className="finding-acknowledge">
          <label className="field">
            <span>سبب قبول المتابعة</span>
            <textarea
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button
            className="button button--secondary"
            type="button"
            disabled={busy || !note.trim()}
            onClick={() => void onAcknowledge(finding, note.trim())}
          >
            إقرار الملاحظة المانعة
          </button>
        </div>
      ) : null}
    </li>
  );
}
