import { useCallback, useEffect, useState } from "react";

import { ApiError, type ApiClient } from "../api";
import type { QuotaDecision } from "../components/jobs/QuotaDecisionDialog";
import type {
  CredentialIncident,
  QueueAction,
  QueueJobProjection,
  QueueProjection,
  QuotaIncident,
  StorageControl,
} from "../types";

export type DirectAction = Exclude<QueueAction, "priority" | "open_gate">;

export interface QueueActions {
  quotaResume: (incident: QuotaIncident) => void;
  credentialResume: (incident: CredentialIncident) => void;
  storageResume: (storage: StorageControl) => void;
  job: (job: QueueJobProjection, action: DirectAction) => void;
  priority: (job: QueueJobProjection, priority: number) => void;
  project: (
    projectId: string,
    action: "pause" | "resume",
    impactHash: string,
  ) => void;
  quota: (incident: QuotaIncident, decision: QuotaDecision) => Promise<boolean>;
}

export function useQueueData(client: ApiClient) {
  const [projection, setProjection] = useState<QueueProjection | null>(null);
  const [error, setError] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const refresh = useCallback(async () => {
    try {
      setProjection(await client.jobs());
      setError(false);
    } catch {
      setError(true);
    }
  }, [client]);
  useQueuePolling(refresh);
  const run = useQueueAction(refresh, setBusyKey, setActionMessage);
  return {
    projection,
    error,
    busyKey,
    busy: busyKey !== null,
    actionMessage,
    refresh,
    run,
  };
}

function useQueuePolling(refresh: () => Promise<void>): void {
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const initial = window.setTimeout(poll, 0);
    const timer = window.setInterval(poll, 4_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);
}

function useQueueAction(
  refresh: () => Promise<void>,
  setBusyKey: (key: string | null) => void,
  setActionMessage: (message: string) => void,
) {
  return useCallback(
    async (key: string, action: () => Promise<unknown>, success: string) => {
      setBusyKey(key);
      setActionMessage("");
      try {
        await action();
        await refresh();
        setActionMessage(success);
        return true;
      } catch (reason) {
        setActionMessage(actionError(reason));
        await refresh();
        return false;
      } finally {
        setBusyKey(null);
      }
    },
    [refresh, setActionMessage, setBusyKey],
  );
}

export type QueueData = ReturnType<typeof useQueueData>;

export function createQueueActions(
  client: ApiClient,
  queue: QueueData,
): QueueActions {
  return {
    quotaResume: (incident) => {
      const impact = incident.resumeImpact;
      if (!impact) return;
      void queue.run(
        `quota:${incident.id}`,
        () =>
          client.resumeQuota(incident.id, {
            actionId: newActionId(),
            expectedRevision: incident.revision,
            impactHash: impact.impactHash,
            confirmedAffectedCount: impact.affectedCount,
          }),
        "عادت حصة المزوّد واستؤنفت المهام المرتبطة.",
      );
    },
    credentialResume: (incident) =>
      runCredentialResume(client, queue, incident),
    storageResume: (storage) => runStorageResume(client, queue, storage),
    job: (job, action) => runJobAction(client, queue, job, action),
    priority: (job, priority) => runPriority(client, queue, job, priority),
    project: (projectId, action, impactHash) =>
      runProjectAction(client, queue, projectId, action, impactHash),
    quota: (incident, decision) =>
      queue.run(
        `quota:${incident.id}`,
        () =>
          client.decideQuota({
            incidentId: incident.id,
            actionId: newActionId(),
            expectedRevision: incident.revision,
            ...decision,
          }),
        decision.decision === "wait"
          ? "سُجّل قرار الانتظار لهذا النطاق."
          : "أُنشئت مهام بديلة مرتبطة لهذا النطاق.",
      ),
  };
}

function newActionId(): string {
  return globalThis.crypto.randomUUID();
}

function runCredentialResume(
  client: ApiClient,
  queue: QueueData,
  incident: CredentialIncident,
): void {
  const impactHash = incident.impactHash;
  if (!impactHash) return;
  void queue.run(
    `credentials:${incident.id}`,
    () => client.resumeCredentials(incident.id, incident.revision, impactHash),
    "نجح فحص بيانات الاتصال واستؤنفت المهام المرتبطة.",
  );
}

function runStorageResume(
  client: ApiClient,
  queue: QueueData,
  storage: StorageControl,
): void {
  const impact = storage.resumeImpact;
  if (!impact) return;
  void queue.run(
    "storage",
    () =>
      client.resumeJobStorage({
        expectedRevision: impact.expectedRevision,
        impactHash: impact.impactHash,
        confirmedAffectedCount: impact.affectedCount,
        confirmed: true,
      }),
    "نجح فحص التخزين واستؤنفت المهام المرتبطة.",
  );
}

function runJobAction(
  client: ApiClient,
  queue: QueueData,
  job: QueueJobProjection,
  action: DirectAction,
): void {
  void queue.run(
    job.id,
    () =>
      client.jobAction(job.id, action, {
        expectedRevision: job.revision,
        expectedState: job.state,
      }),
    actionMessage(action),
  );
}

function runPriority(
  client: ApiClient,
  queue: QueueData,
  job: QueueJobProjection,
  priority: number,
): void {
  void queue.run(
    job.id,
    () =>
      client.setJobPriority(job.id, {
        expectedRevision: job.revision,
        expectedState: job.state,
        priority,
      }),
    "تغيّرت أولوية المهمة.",
  );
}

function runProjectAction(
  client: ApiClient,
  queue: QueueData,
  projectId: string,
  action: "pause" | "resume",
  impactHash: string,
): void {
  void queue.run(
    `project:${projectId}`,
    () =>
      action === "pause"
        ? client.pauseProjectJobs(projectId, impactHash)
        : client.resumeProjectJobs(projectId, impactHash),
    action === "pause"
      ? "توقفت المهام غير المنفّذة في المشروع."
      : "استؤنفت المهام التي أوقفها المشغّل في المشروع.",
  );
}

function actionMessage(action: DirectAction): string {
  return {
    pause: "توقفت المهمة مؤقتًا.",
    resume: "استؤنفت المهمة.",
    cancel: "أُلغيت المهمة ولن تُحفظ نتيجة متأخرة.",
    retry: "بدأت دورة إعادة محاولة موثّقة.",
  }[action];
}

function actionError(reason: unknown): string {
  if (
    reason instanceof ApiError &&
    ["JOB_REVISION_CONFLICT", "JOB_STATE_CONFLICT"].includes(reason.code)
  )
    return "تغيّرت المهمة قبل تنفيذ الإجراء. حُدّثت القائمة؛ راجع حالتها وحاول مجددًا.";
  return "تعذّر تنفيذ الإجراء. لم يتغير العمل المحفوظ.";
}
