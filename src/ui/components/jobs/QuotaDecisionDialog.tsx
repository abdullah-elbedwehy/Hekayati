import { useEffect, useRef, useState } from "react";

import type { JobTarget, QuotaIncident } from "../../types";
import {
  formatQueueNumber,
  operationLabel,
  providerLabel,
  shortId,
} from "./format";

export interface QuotaDecision {
  impactHash: string;
  projectId: string | null;
  standaloneScopeId: string | null;
  decision: "wait" | "continue";
  alternateTarget?: JobTarget;
}

export function QuotaDecisionDialog({
  incident,
  busy,
  onClose,
  onDecision,
}: {
  incident: QuotaIncident | null;
  busy: boolean;
  onClose: () => void;
  onDecision: (decision: QuotaDecision) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (incident && !element.open) element.showModal();
    if (!incident && element.open) element.close();
  }, [incident]);
  return (
    <dialog
      className="quota-dialog"
      ref={dialog}
      aria-labelledby="quota-dialog-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClose={onClose}
    >
      {incident && (
        <QuotaDialogContent
          key={incident.id}
          incident={incident}
          busy={busy}
          onDecision={onDecision}
        />
      )}
    </dialog>
  );
}

interface QuotaDialogContentProps {
  incident: QuotaIncident;
  busy: boolean;
  onDecision: (decision: QuotaDecision) => void;
}

function QuotaDialogContent({
  incident,
  busy,
  onDecision,
}: QuotaDialogContentProps) {
  const scopes = incidentScopes(incident);
  const [scopeId, setScopeId] = useState(scopes[0]?.id ?? "");
  const [targetIndex, setTargetIndex] = useState(0);
  const scope =
    scopes.find((candidate) => candidate.id === scopeId) ?? scopes[0];
  const targets = incident.alternateTargets ?? [];
  const target = targets[targetIndex];
  return (
    <form method="dialog" className="quota-dialog__surface">
      <QuotaDialogHeader incident={incident} busy={busy} />
      <p>
        العملية: {operationLabel(incident.operation)}. الأعمال المكتملة وسجل
        منشئها لن يتغيرا أيًا كان القرار.
      </p>
      <ScopeChooser scopes={scopes} scope={scope} setScopeId={setScopeId} />
      {scope && (
        <p className="quota-dialog__impact">
          القرار يشمل {formatQueueNumber(scope.count)} مهمة متبقية في{" "}
          {scope.label}.
        </p>
      )}
      <TargetChooser
        targets={targets}
        targetIndex={targetIndex}
        setTargetIndex={setTargetIndex}
      />
      {targets.length === 0 && (
        <p className="job-warning">
          لا توجد وجهة بديلة متاحة ومتحقق منها الآن. يمكن الانتظار فقط.
        </p>
      )}
      <DecisionButtons
        scope={scope}
        target={target}
        busy={busy}
        onDecision={onDecision}
      />
    </form>
  );
}

function QuotaDialogHeader({
  incident,
  busy,
}: {
  incident: QuotaIncident;
  busy: boolean;
}) {
  return (
    <div className="quota-dialog__heading">
      <div>
        <p className="eyebrow">قرار واضح لكل نطاق عمل</p>
        <h2 id="quota-dialog-title">
          توقفت حصة {providerLabel(incident.providerId)}
        </h2>
      </div>
      <button className="quota-dialog__close" value="cancel" disabled={busy}>
        إغلاق
      </button>
    </div>
  );
}

function ScopeChooser({
  scopes,
  scope,
  setScopeId,
}: {
  scopes: IncidentScope[];
  scope?: IncidentScope;
  setScopeId: (id: string) => void;
}) {
  if (scopes.length <= 1) return null;
  return (
    <label className="field">
      <span>نطاق القرار</span>
      <select
        value={scope?.id ?? ""}
        onChange={(event) => setScopeId(event.target.value)}
      >
        {scopes.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.label}، {formatQueueNumber(candidate.count)} مهمة متبقية
          </option>
        ))}
      </select>
    </label>
  );
}

function TargetChooser({
  targets,
  targetIndex,
  setTargetIndex,
}: {
  targets: JobTarget[];
  targetIndex: number;
  setTargetIndex: (index: number) => void;
}) {
  if (targets.length <= 1) return null;
  return (
    <label className="field">
      <span>الوجهة البديلة المتاحة</span>
      <select
        value={targetIndex}
        onChange={(event) => setTargetIndex(Number(event.target.value))}
      >
        {targets.map((candidate, index) => (
          <option key={targetKey(candidate)} value={index}>
            {providerLabel(candidate.providerId)}، {candidate.modelId}
          </option>
        ))}
      </select>
    </label>
  );
}

function DecisionButtons({
  scope,
  target,
  busy,
  onDecision,
}: {
  scope?: IncidentScope;
  target?: JobTarget;
  busy: boolean;
  onDecision: (decision: QuotaDecision) => void;
}) {
  const payload = scopePayload(scope);
  return (
    <div className="quota-dialog__decisions">
      <button
        className="button button--secondary"
        type="button"
        disabled={busy || !scope}
        onClick={() => scope && onDecision({ ...payload, decision: "wait" })}
      >
        انتظار عودة المزوّد
      </button>
      {target && (
        <button
          className="button button--primary"
          type="button"
          disabled={busy || !scope}
          onClick={() =>
            scope &&
            onDecision({
              ...payload,
              decision: "continue",
              alternateTarget: target,
            })
          }
        >
          متابعة المهام المتبقية عبر {providerLabel(target.providerId)}
        </button>
      )}
    </div>
  );
}

interface IncidentScope {
  id: string;
  label: string;
  projectId: string | null;
  standaloneScopeId: string | null;
  impactHash: string;
  count: number;
}

function incidentScopes(incident: QuotaIncident): IncidentScope[] {
  return incident.scopes.map((scope) => {
    const id = scope.projectId ?? scope.standaloneScopeId ?? "";
    return {
      id,
      label: scope.projectId
        ? `مشروع ${shortId(id)}`
        : `عمل مستقل ${shortId(id)}`,
      projectId: scope.projectId,
      standaloneScopeId: scope.standaloneScopeId,
      impactHash: scope.impactHash,
      count: scope.affectedCount,
    };
  });
}

function scopePayload(scope: IncidentScope | undefined) {
  return {
    impactHash: scope?.impactHash ?? "",
    projectId: scope?.projectId ?? null,
    standaloneScopeId: scope?.standaloneScopeId ?? null,
  };
}

function targetKey(target: JobTarget): string {
  return `${target.providerId}:${target.modelId}:${target.operation}:${target.settingsHash}`;
}
