import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { localJobRegistration } from "../../src/jobs/registrations.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { JobScheduler } from "../../src/jobs/scheduler.js";
import type { EnqueueJobInput, ClaimOptions } from "../../src/jobs/types.js";
import { temporaryDirectory } from "../helpers/temp.js";

const projectId = "01J00000000000000000000001";
const hash = "a".repeat(64);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("atomic indexed job claim", () => {
  it("claims one ordered candidate and enforces provider capacity in SQL", async () => {
    const { store, close } = await harness();
    const scheduler = new JobScheduler(store, {
      registeredJobs: [localJobRegistration("fixture_noop")],
      nowIso: () => "2026-07-14T00:00:00.000Z",
    });
    const low = scheduler.enqueue(input("low", "mock", 1));
    const high = scheduler.enqueue(input("high", "mock", 5));
    const other = scheduler.enqueue(input("other", "gemini", 3));
    const repository = new JobRepository(store);

    const first = repository.claimNext(
      claimOptions(1),
      lease("claim-1"),
      "2026-07-14T00:00:01.000Z",
    );
    expect(first).toMatchObject({ id: high.id, state: "claimed", attempts: 1 });
    expect(first?.revision).toBe(high.revision + 1);

    const second = repository.claimNext(
      claimOptions(1),
      lease("claim-2"),
      "2026-07-14T00:00:02.000Z",
    );
    expect(second?.id).toBe(other.id);
    expect(repository.get(low.id)?.state).toBe("queued");
    close();
  });
});

async function harness() {
  const temp = await temporaryDirectory("hekayati-atomic-claim-");
  cleanups.push(temp.cleanup);
  const store = new DocumentStore(join(temp.path, "jobs.db"));
  return { store, close: () => store.close() };
}

function input(
  intentId: string,
  providerId: "mock" | "gemini",
  priority: number,
): EnqueueJobInput {
  return {
    jobType: "fixture_noop",
    projectId,
    standaloneScopeId: null,
    dependsOn: [],
    priority,
    intentId,
    target: {
      providerId,
      modelId: `${providerId}-v1`,
      operation: "image",
      settingsHash: hash,
    },
    request: { kind: "local", payloadHash: hash },
    inputSnapshot: {},
  };
}

function claimOptions(concurrencyPerProvider: number): ClaimOptions {
  return {
    workerId: "worker",
    bootId: "boot",
    nowMonoMs: 10,
    nowWallMs: Date.parse("2026-07-14T00:00:01.000Z"),
    leaseTtlMs: 1_000,
    concurrencyPerProvider,
  };
}

function lease(claimToken: string) {
  return {
    workerId: "worker",
    bootId: "boot",
    claimToken,
    claimedAtMono: 10,
    expiresAtMono: 1_010,
  };
}
