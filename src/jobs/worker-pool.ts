import { makeFailure, type NormalizedFailure } from "../providers/failures.js";
import { JobError } from "./errors.js";
import { classifyRuntimeError } from "./runtime-errors.js";
import type { JobScheduler } from "./scheduler.js";
import type { JobRecord } from "./schemas.js";
import type { JobClock, JobFence, RegisteredJobDefinition } from "./types.js";

export interface JobWorkerPoolOptions {
  bootId: string;
  workerId: string;
  clock: JobClock;
  concurrencyPerProvider: number;
  getConcurrencyPerProvider?: () => number;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  timeoutMs: number;
  pollIntervalMs: number;
  maxWorkers: number;
  onDatabaseUnavailable?: (error: unknown) => void;
}

interface ActiveExecution {
  controller: AbortController;
  fence: JobFence;
}

export class JobWorkerPool {
  private readonly definitions = new Map<string, RegisteredJobDefinition>();
  private readonly active = new Map<string, ActiveExecution>();
  private readonly inflight = new Set<Promise<boolean>>();
  private accepting = true;
  private databaseHalted = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly scheduler: JobScheduler,
    definitions: readonly RegisteredJobDefinition[],
    private readonly options: JobWorkerPoolOptions,
  ) {
    validateOptions(options);
    for (const definition of definitions) {
      if (this.definitions.has(definition.jobType))
        throw new JobError("JOB_DEFINITION_DUPLICATE");
      this.definitions.set(definition.jobType, definition);
    }
  }

  start(): void {
    if (this.pollTimer || this.databaseHalted) return;
    this.accepting = true;
    this.fillSlots();
    this.pollTimer = setInterval(
      () => this.fillSlots(),
      this.options.pollIntervalMs,
    );
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopAccepting();
    const now = this.options.clock.monotonicNow();
    let stopError: unknown;
    this.abortActive();
    for (const [jobId, execution] of this.active) {
      try {
        this.scheduler.requeueOwned(jobId, execution.fence, now);
      } catch (error) {
        if (isOwnershipLoss(error)) continue;
        if (classifyRuntimeError(error)) {
          this.haltForDatabase(error);
          continue;
        }
        stopError ??= error;
      }
    }
    await Promise.allSettled([...this.inflight]);
    if (stopError) throw workerStopError(stopError);
  }

  halt(): void {
    this.stopAcceptingAndAbort();
  }

  async runOne(): Promise<boolean> {
    if (!this.accepting) return false;
    try {
      const wallNowIso = this.options.clock.wallNowIso();
      const claimed = this.scheduler.claimNext({
        workerId: this.options.workerId,
        bootId: this.options.bootId,
        nowMonoMs: this.options.clock.monotonicNow(),
        nowWallMs: Date.parse(wallNowIso),
        leaseTtlMs: this.options.leaseTtlMs,
        concurrencyPerProvider: this.currentConcurrency(),
      });
      if (!claimed) return false;
      await this.executeClaim(claimed);
      return true;
    } catch (error) {
      if (isOwnershipLoss(error)) return false;
      if (classifyRuntimeError(error)) {
        this.haltForDatabase(error);
        return false;
      }
      throw error;
    }
  }

  activeCount(): number {
    return this.active.size;
  }

  private async executeClaim(claimed: JobRecord): Promise<void> {
    const fence = fenceFor(claimed);
    const running = this.scheduler.markRunning(
      claimed.id,
      fence,
      this.options.clock.monotonicNow(),
    );
    const controller = new AbortController();
    this.active.set(running.id, { controller, fence });
    const heartbeat = this.startHeartbeat(running.id, fence, controller);
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs,
    );
    timeout.unref?.();
    const definition = this.definitions.get(running.jobType);
    try {
      await this.executeDefinition(running, fence, controller, definition);
    } catch (error) {
      this.recordUnexpected(running.id, fence, definition, error, controller);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      this.active.delete(running.id);
    }
  }

  private async executeDefinition(
    running: JobRecord,
    fence: JobFence,
    controller: AbortController,
    definition: RegisteredJobDefinition | undefined,
  ): Promise<void> {
    if (!definition) throw new JobError("JOB_DEFINITION_MISSING");
    const prepared = await definition.prepare(running, this.batchId());
    const result = await definition.execute({
      job: running,
      prepared,
      signal: controller.signal,
      timeoutMs: this.options.timeoutMs,
    });
    if (!result.ok) {
      this.recordFailure(running.id, fence, result.failure);
      return;
    }
    try {
      this.scheduler.commitWith(
        running.id,
        fence,
        this.options.clock.monotonicNow(),
        (current) =>
          definition.commit({
            job: current,
            value: result.value,
            provenance: result.provenance ?? null,
          }),
      );
    } catch (error) {
      await definition.discard?.(result.value);
      this.recordCommitRejection(running.id, fence, error);
      throw error;
    }
  }

  private startHeartbeat(
    jobId: string,
    fence: JobFence,
    controller: AbortController,
  ): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      try {
        this.scheduler.heartbeat(jobId, fence, {
          nowMonoMs: this.options.clock.monotonicNow(),
          wallNowIso: this.options.clock.wallNowIso(),
          leaseTtlMs: this.options.leaseTtlMs,
        });
      } catch (error) {
        if (classifyRuntimeError(error)) this.haltForDatabase(error);
        else controller.abort();
      }
    }, this.options.heartbeatIntervalMs);
    timer.unref?.();
    return timer;
  }

  private recordUnexpected(
    jobId: string,
    fence: JobFence,
    definition: RegisteredJobDefinition | undefined,
    error: unknown,
    controller: AbortController,
  ): void {
    if (
      isOwnershipLoss(error) ||
      (!this.accepting && controller.signal.aborted)
    )
      return;
    const runtimeCategory = classifyRuntimeError(error);
    const failure = runtimeCategory
      ? makeFailure(runtimeCategory)
      : (definition?.normalizeError?.(error) ??
        normalizeWorkerError(error, controller));
    try {
      this.recordFailure(jobId, fence, failure);
    } catch (recordError) {
      if (!isOwnershipLoss(recordError)) throw recordError;
    }
  }

  private recordFailure(
    jobId: string,
    fence: JobFence,
    failure: NormalizedFailure,
  ): void {
    if (failure.category === "database_unavailable") {
      this.haltForDatabase(new JobError("JOB_DATABASE_UNAVAILABLE", 503));
      return;
    }
    this.scheduler.recordFailure(jobId, fence, failure, {
      nowMonoMs: this.options.clock.monotonicNow(),
      wallNowIso: this.options.clock.wallNowIso(),
    });
    if (
      failure.category === "disk_write_failure" ||
      failure.category === "insufficient_disk_space"
    )
      this.abortActive();
  }

  private recordCommitRejection(
    jobId: string,
    fence: JobFence,
    error: unknown,
  ): void {
    if (classifyRuntimeError(error)) return;
    try {
      this.scheduler.recordCommitRejected(jobId, fence);
    } catch (recordError) {
      if (classifyRuntimeError(recordError)) this.haltForDatabase(recordError);
      else if (!isOwnershipLoss(recordError)) throw recordError;
    }
  }

  private fillSlots(): void {
    while (this.accepting && this.inflight.size < this.options.maxWorkers) {
      const execution = this.runOne();
      this.inflight.add(execution);
      void execution
        .catch(() => this.stopAcceptingAndAbort())
        .finally(() => this.inflight.delete(execution));
    }
  }

  private currentConcurrency(): number {
    const concurrency =
      this.options.getConcurrencyPerProvider?.() ??
      this.options.concurrencyPerProvider;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
      throw new JobError("JOB_WORKER_OPTIONS_INVALID", 400);
    return concurrency;
  }

  private haltForDatabase(error: unknown): void {
    if (this.databaseHalted) return;
    this.databaseHalted = true;
    this.stopAcceptingAndAbort();
    this.options.onDatabaseUnavailable?.(error);
  }

  private stopAcceptingAndAbort(): void {
    this.stopAccepting();
    this.abortActive();
  }

  private stopAccepting(): void {
    this.accepting = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private abortActive(): void {
    for (const execution of this.active.values()) execution.controller.abort();
  }

  private batchId(): string {
    return `batch-${this.options.bootId}`;
  }
}

function fenceFor(job: JobRecord): JobFence {
  if (!job.lease) throw new JobError("JOB_NOT_CLAIMED");
  return {
    workerId: job.lease.workerId,
    bootId: job.lease.bootId,
    claimToken: job.lease.claimToken,
    attempt: job.attempts,
  };
}

function normalizeWorkerError(
  error: unknown,
  controller: AbortController,
): NormalizedFailure {
  const runtimeCategory = classifyRuntimeError(error);
  if (runtimeCategory) return makeFailure(runtimeCategory);
  if (controller.signal.aborted) return makeFailure("timeout");
  if (error instanceof JobError) {
    if (error.code.includes("STALE") || error.code.includes("LINEAGE"))
      return makeFailure("stale_dependency", { reasonCode: error.code });
    if (
      error.code.startsWith("PHOTO_") ||
      error.code.includes("REFERENCE") ||
      error.code.includes("SHEET_")
    )
      return makeFailure("missing_reference_asset", {
        reasonCode: error.code,
      });
    if (error.code.includes("CAPABILITY") || error.code.includes("PROVIDER_"))
      return makeFailure("provider_unavailable");
  }
  return makeFailure("unknown");
}

function isOwnershipLoss(error: unknown): boolean {
  return (
    error instanceof JobError &&
    [
      "JOB_FENCE_MISMATCH",
      "JOB_LEASE_EXPIRED",
      "JOB_REVISION_CONFLICT",
      "JOB_NOT_FOUND",
    ].includes(error.code)
  );
}

function validateOptions(options: JobWorkerPoolOptions): void {
  if (
    !options.bootId ||
    !options.workerId ||
    options.leaseTtlMs <= 0 ||
    options.heartbeatIntervalMs <= 0 ||
    options.heartbeatIntervalMs >= options.leaseTtlMs ||
    options.timeoutMs <= 0 ||
    options.pollIntervalMs <= 0 ||
    options.maxWorkers < 1 ||
    options.maxWorkers > 4 ||
    options.concurrencyPerProvider < 1 ||
    options.concurrencyPerProvider > 4
  )
    throw new JobError("JOB_WORKER_OPTIONS_INVALID", 400);
}

function workerStopError(error: unknown): Error {
  return error instanceof Error ? error : new Error("JOB_WORKER_STOP_FAILED");
}
