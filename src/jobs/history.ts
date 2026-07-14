import { ulid } from "ulid";

import {
  DocumentRepository,
  type DocumentStore,
} from "../domain/repository/document-store.js";
import { JobError } from "./errors.js";
import {
  credentialIncidentSchema,
  credentialRemediationAuditSchema,
  jobEventSchema,
  providerTargetChangeAuditSchema,
  quotaDecisionAuditSchema,
  quotaIncidentSchema,
  storageControlSchema,
  type CredentialIncident,
  type CredentialRemediationAudit,
  type JobEvent,
  type JobEventKind,
  type JobRecord,
  type JobState,
  type ProviderTargetChangeAudit,
  type QuotaDecisionAudit,
  type QuotaIncident,
  type StorageControl,
} from "./schemas.js";

interface EventDetails {
  fromState?: JobState | null;
  toState?: JobState | null;
  reason?: string | null;
  noteCode?: string | null;
}

export class JobHistory {
  private readonly eventsRepository: DocumentRepository<JobEvent>;
  private readonly incidentRepository: DocumentRepository<QuotaIncident>;
  private readonly auditRepository: DocumentRepository<QuotaDecisionAudit>;
  private readonly targetChangeRepository: DocumentRepository<ProviderTargetChangeAudit>;
  private readonly credentialIncidentRepository: DocumentRepository<CredentialIncident>;
  private readonly credentialAuditRepository: DocumentRepository<CredentialRemediationAudit>;
  private readonly storageRepository: DocumentRepository<StorageControl>;

  constructor(
    private readonly store: DocumentStore,
    private readonly nowIso: () => string,
    private readonly idFactory: () => string = ulid,
  ) {
    this.eventsRepository = new DocumentRepository(
      store,
      "job_events",
      jobEventSchema,
    );
    this.incidentRepository = new DocumentRepository(
      store,
      "quota_incidents",
      quotaIncidentSchema,
    );
    this.auditRepository = new DocumentRepository(
      store,
      "job_audit_events",
      quotaDecisionAuditSchema,
    );
    this.targetChangeRepository = new DocumentRepository(
      store,
      "provider_target_change_audits",
      providerTargetChangeAuditSchema,
    );
    this.credentialIncidentRepository = new DocumentRepository(
      store,
      "credential_incidents",
      credentialIncidentSchema,
    );
    this.credentialAuditRepository = new DocumentRepository(
      store,
      "credential_remediation_audits",
      credentialRemediationAuditSchema,
    );
    this.storageRepository = new DocumentRepository(
      store,
      "scheduler_controls",
      storageControlSchema,
    );
    this.createIndexes();
  }

  append(
    job: JobRecord,
    kind: JobEventKind,
    details: EventDetails = {},
    attempt: number | null = job.attempts > 0 ? job.attempts : null,
  ): JobEvent {
    const now = this.nowIso();
    return this.eventsRepository.put(
      jobEventSchema.parse({
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        jobId: job.id,
        sequence: this.nextSequence(job.id),
        kind,
        attempt,
        fromState: details.fromState ?? null,
        toState: details.toState ?? null,
        reason: details.reason ?? null,
        noteCode: details.noteCode ?? null,
      }),
    );
  }

  events(jobId: string): JobEvent[] {
    return this.eventsRepository
      .queryByField("jobId", jobId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  quotaIncidents(): QuotaIncident[] {
    return this.incidentRepository.list();
  }

  quotaIncident(id: string): QuotaIncident {
    const incident = this.incidentRepository.get(id);
    if (!incident) throw new JobError("JOB_QUOTA_INCIDENT_NOT_FOUND", 404);
    return incident;
  }

  openQuotaIncident(
    job: JobRecord & { target: NonNullable<JobRecord["target"]> },
    affectedJobs: readonly JobRecord[],
  ): QuotaIncident {
    const existing = this.quotaIncidents().find(
      (incident) =>
        incident.status === "open" &&
        incident.providerId === job.target.providerId &&
        incident.operation === job.target.operation,
    );
    const scopes = unique([
      ...(existing?.affectedScopeIds ?? []),
      ...affectedJobs.map(scopeId),
    ]);
    const ownedJobIds = unique([
      ...(existing?.ownedJobIds ?? []),
      ...affectedJobs.map((affected) => affected.id),
    ]);
    const originalTargets = uniqueTargets([
      ...(existing?.originalTargets ?? []),
      ...affectedJobs.flatMap((affected) =>
        affected.target ? [affected.target] : [],
      ),
    ]);
    const now = this.nowIso();
    return this.incidentRepository.put(
      quotaIncidentSchema.parse({
        id: existing?.id ?? this.idFactory(),
        schemaVersion: 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        revision: existing ? existing.revision + 1 : 0,
        providerId: job.target.providerId,
        operation: job.target.operation,
        status: "open",
        affectedScopeIds: scopes,
        ownedJobIds,
        originalTargets,
      }),
    );
  }

  resolveQuotaIncident(incident: QuotaIncident): QuotaIncident {
    return this.incidentRepository.put(
      quotaIncidentSchema.parse({
        ...incident,
        status: "resolved",
        updatedAt: this.nowIso(),
        revision: incident.revision + 1,
      }),
    );
  }

  appendAudit(
    input: Omit<
      QuotaDecisionAudit,
      "id" | "schemaVersion" | "createdAt" | "updatedAt"
    >,
  ): QuotaDecisionAudit {
    const now = this.nowIso();
    return this.auditRepository.put(
      quotaDecisionAuditSchema.parse({
        ...input,
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  auditEvents(): QuotaDecisionAudit[] {
    return this.auditRepository.list();
  }

  quotaAuditByActionId(actionId: string): QuotaDecisionAudit | null {
    return this.auditRepository.queryByField("actionId", actionId)[0] ?? null;
  }

  quotaDecisionForScope(input: {
    incidentId: string;
    projectId: string | null;
    standaloneScopeId: string | null;
  }): QuotaDecisionAudit | null {
    return (
      this.auditRepository
        .queryByField("incidentId", input.incidentId)
        .find(
          (audit) =>
            audit.decision !== "resume" &&
            audit.projectId === input.projectId &&
            audit.standaloneScopeId === input.standaloneScopeId,
        ) ?? null
    );
  }

  credentialIncidents(): CredentialIncident[] {
    return this.credentialIncidentRepository.list();
  }

  credentialIncident(id: string): CredentialIncident {
    const incident = this.credentialIncidentRepository.get(id);
    if (!incident) throw new JobError("JOB_CREDENTIAL_INCIDENT_NOT_FOUND", 404);
    return incident;
  }

  openCredentialIncident(
    job: JobRecord & { target: NonNullable<JobRecord["target"]> },
    affectedJobs: readonly JobRecord[],
  ): CredentialIncident {
    const existing = this.credentialIncidents().find(
      (incident) =>
        incident.status === "open" &&
        incident.providerId === job.target.providerId,
    );
    const now = this.nowIso();
    return this.credentialIncidentRepository.put(
      credentialIncidentSchema.parse({
        id: existing?.id ?? this.idFactory(),
        schemaVersion: 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        revision: existing ? existing.revision + 1 : 0,
        providerId: job.target.providerId,
        status: "open",
        affectedScopeIds: unique([
          ...(existing?.affectedScopeIds ?? []),
          ...affectedJobs.map(scopeId),
        ]),
        ownedJobIds: unique([
          ...(existing?.ownedJobIds ?? []),
          ...affectedJobs.map((affected) => affected.id),
        ]),
        originalTargets: uniqueTargets([
          ...(existing?.originalTargets ?? []),
          ...affectedJobs.flatMap((affected) =>
            affected.target ? [affected.target] : [],
          ),
        ]),
      }),
    );
  }

  resolveCredentialIncident(incident: CredentialIncident): CredentialIncident {
    return this.credentialIncidentRepository.put(
      credentialIncidentSchema.parse({
        ...incident,
        status: "resolved",
        updatedAt: this.nowIso(),
        revision: incident.revision + 1,
      }),
    );
  }

  appendCredentialAudit(
    input: Omit<
      CredentialRemediationAudit,
      "id" | "schemaVersion" | "createdAt" | "updatedAt"
    >,
  ): CredentialRemediationAudit {
    const now = this.nowIso();
    return this.credentialAuditRepository.put(
      credentialRemediationAuditSchema.parse({
        ...input,
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  credentialAuditEvents(): CredentialRemediationAudit[] {
    return this.credentialAuditRepository.list();
  }

  appendTargetChangeAudit(
    input: Omit<
      ProviderTargetChangeAudit,
      "id" | "schemaVersion" | "createdAt" | "updatedAt"
    >,
  ): ProviderTargetChangeAudit {
    const now = this.nowIso();
    return this.targetChangeRepository.put(
      providerTargetChangeAuditSchema.parse({
        ...input,
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  targetChangeAudits(): ProviderTargetChangeAudit[] {
    return this.targetChangeRepository.list();
  }

  storageStatus(): StorageControl {
    const existing = this.storageRepository.get("scheduler");
    if (existing) return existing;
    const now = this.nowIso();
    return this.storageRepository.put({
      id: "scheduler",
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      active: false,
      reason: null,
      incidentId: null,
      ownedJobIds: [],
      detectedAt: null,
      lastProbeAt: null,
      lastProbeStatus: null,
      workerStatus: "stopped",
      bootId: null,
      lastRecoveryAt: null,
    });
  }

  updateStorage(input: Partial<StorageControl>): StorageControl {
    const current = this.storageStatus();
    return this.storageRepository.put(
      storageControlSchema.parse({
        ...current,
        ...input,
        id: "scheduler",
        updatedAt: this.nowIso(),
        revision: current.revision + 1,
      }),
    );
  }

  openStorageIncident(input: {
    reason: NonNullable<StorageControl["reason"]>;
    detectedAt: string;
    ownedJobIds: readonly string[];
  }): StorageControl {
    const current = this.storageStatus();
    return this.updateStorage({
      active: true,
      reason: current.active ? (current.reason ?? input.reason) : input.reason,
      incidentId:
        current.active && current.incidentId
          ? current.incidentId
          : this.idFactory(),
      ownedJobIds: unique([
        ...(current.active ? current.ownedJobIds : []),
        ...input.ownedJobIds,
      ]),
      detectedAt: current.active
        ? (current.detectedAt ?? input.detectedAt)
        : input.detectedAt,
      lastProbeAt: null,
      lastProbeStatus: null,
    });
  }

  private nextSequence(jobId: string): number {
    const row = this.store.database
      .prepare(
        `SELECT MAX(CAST(json_extract(doc, '$.sequence') AS INTEGER)) AS sequence
         FROM documents
         WHERE collection = 'job_events'
           AND json_extract(doc, '$.jobId') = ?`,
      )
      .get(jobId) as { sequence: number | null };
    return (row.sequence ?? 0) + 1;
  }

  private createIndexes(): void {
    this.store.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS job_events_job_sequence
        ON documents(
          json_extract(doc, '$.jobId'),
          CAST(json_extract(doc, '$.sequence') AS INTEGER)
        ) WHERE collection = 'job_events';
      CREATE INDEX IF NOT EXISTS quota_incidents_provider_status
        ON documents(
          json_extract(doc, '$.providerId'),
          json_extract(doc, '$.operation'),
          json_extract(doc, '$.status')
        ) WHERE collection = 'quota_incidents';
      CREATE UNIQUE INDEX IF NOT EXISTS quota_audit_action_id
        ON documents(json_extract(doc, '$.actionId'))
        WHERE collection = 'job_audit_events';
      CREATE UNIQUE INDEX IF NOT EXISTS quota_audit_scope_decision
        ON documents(
          json_extract(doc, '$.incidentId'),
          COALESCE(
            json_extract(doc, '$.projectId'),
            json_extract(doc, '$.standaloneScopeId')
          )
        )
        WHERE collection = 'job_audit_events'
          AND json_extract(doc, '$.decision') IN ('wait', 'continue');
      CREATE INDEX IF NOT EXISTS credential_incidents_provider_status
        ON documents(
          json_extract(doc, '$.providerId'),
          json_extract(doc, '$.status')
        ) WHERE collection = 'credential_incidents';
    `);
  }
}

function scopeId(job: JobRecord): string {
  return job.projectId ?? job.standaloneScopeId!;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueTargets(
  targets: readonly NonNullable<JobRecord["target"]>[],
): NonNullable<JobRecord["target"]>[] {
  const byKey = new Map<string, NonNullable<JobRecord["target"]>>();
  for (const target of targets) {
    const key = [
      target.providerId,
      target.modelId,
      target.operation,
      target.settingsHash,
    ].join("\u0000");
    if (!byKey.has(key)) byKey.set(key, target);
  }
  return [...byKey.values()];
}
