import type { DocumentStore } from "../domain/repository/document-store.js";
import {
  PortabilityLedgerRepository,
  PortabilityScopeLockRepository,
  PortabilityStorageError,
} from "../domain/portability/repositories.js";
import { ScopeAdmissionService } from "../domain/portability/scope-locks.js";
import type { PortabilityScope } from "../domain/portability/schemas.js";
import { JobError } from "./errors.js";
import type { JobRecord } from "./schemas.js";
import type {
  JobScopeAdmissionPort,
  JobScopeAdmissionPurpose,
} from "./types.js";

interface ProjectOwnerRow {
  customerId: string | null;
}

const deniedCodes = new Set([
  "PORTABILITY_SCOPE_ADMISSION_DENIED",
  "PORTABILITY_SCOPE_BUSY",
]);

export class JobScopeAdmission implements JobScopeAdmissionPort {
  private readonly admission: ScopeAdmissionService;

  constructor(private readonly store: DocumentStore) {
    this.admission = new ScopeAdmissionService(
      store,
      new PortabilityScopeLockRepository(store),
      new PortabilityLedgerRepository(store),
    );
  }

  assertInTransaction(
    job: Readonly<JobRecord>,
    purpose: JobScopeAdmissionPurpose,
  ): void {
    const scope = this.scopeFor(job);
    if (!scope) return;
    try {
      this.admission.assertAdmittedInTransaction({
        scope,
        purpose,
        ...(purpose === "scheduler_run" || purpose === "scheduler_commit"
          ? { job: { jobId: job.id, attempt: job.attempts } }
          : {}),
      });
    } catch (error) {
      if (isAdmissionDenial(error))
        throw new JobError("JOB_SCOPE_ADMISSION_DENIED", 409, {
          cause: error,
        });
      throw error;
    }
  }

  isAdmittedInTransaction(
    job: Readonly<JobRecord>,
    purpose: JobScopeAdmissionPurpose,
  ): boolean {
    try {
      this.assertInTransaction(job, purpose);
      return true;
    } catch (error) {
      if (
        error instanceof JobError &&
        error.code === "JOB_SCOPE_ADMISSION_DENIED"
      )
        return false;
      throw error;
    }
  }

  private scopeFor(job: Readonly<JobRecord>): PortabilityScope | null {
    if (!job.projectId) return null;
    const row = this.store.database
      .prepare(
        `SELECT json_extract(doc, '$.customerId') AS customerId
         FROM documents
         WHERE collection = 'projects' AND id = ?
         LIMIT 1`,
      )
      .get(job.projectId) as ProjectOwnerRow | undefined;
    return {
      kind: "project",
      id: job.projectId,
      projectId: job.projectId,
      customerId: row?.customerId ?? job.projectId,
    };
  }
}

function isAdmissionDenial(error: unknown): boolean {
  return (
    error instanceof PortabilityStorageError && deniedCodes.has(error.code)
  );
}
