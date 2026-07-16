import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { z } from "zod";

import {
  DocumentRepository,
  DocumentStore,
} from "../../src/domain/repository/document-store.js";
import {
  PortabilityActionBoundary,
  portabilityActionRequestHash,
} from "../../src/domain/portability/operation-ledgers.js";
import { PortabilityActionRepository } from "../../src/domain/portability/repositories.js";
import type { PortabilityActionBoundaryInput } from "../../src/domain/portability/operation-ledgers.js";
import { temporaryDirectory } from "../helpers/temp.js";

const fixtureDocumentSchema = z
  .object({
    id: z.string(),
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    value: z.string(),
  })
  .strict();

type FixtureDocument = z.infer<typeof fixtureDocumentSchema>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("portability action boundary", () => {
  it("persists a durable result and returns the exact replay after restart", async () => {
    const fixture = await actionFixture();
    const projectId = ulid();
    const input = actionInput(projectId, "same-key");
    let effects = 0;

    const first = fixture.boundary.run(input, () => {
      effects += 1;
      return inlineResult(projectId);
    });
    expect(first.replayed).toBe(false);
    expect(first.action.result).toEqual(inlineResult(projectId));

    const replay = fixture.boundary.run(input, () => {
      throw new Error("EFFECT_MUST_NOT_REPEAT");
    });
    expect(replay).toEqual({ action: first.action, replayed: true });
    expect(effects).toBe(1);

    fixture.store.close();
    fixture.store = new DocumentStore(fixture.database);
    const restarted = new PortabilityActionBoundary(
      fixture.store,
      new PortabilityActionRepository(fixture.store),
      fixture.options,
    );
    expect(
      restarted.run(input, () => {
        throw new Error("RESTART_REPLAY_MUST_NOT_REPEAT");
      }),
    ).toEqual({ action: first.action, replayed: true });
  });

  it("rejects a key/hash collision before its effect can mutate storage", async () => {
    const fixture = await actionFixture();
    const projectId = ulid();
    const first = actionInput(projectId, "collision-key");
    fixture.boundary.run(first, () => inlineResult(projectId));
    let effectRan = false;
    const changed = {
      ...first,
      input: { ...first.input, counts: { documents: 3 } },
    };

    expect(() =>
      fixture.boundary.run(
        {
          ...changed,
          requestHash: portabilityActionRequestHash(changed),
        },
        () => {
          effectRan = true;
          return inlineResult(projectId);
        },
      ),
    ).toThrow("PORTABILITY_ACTION_IDEMPOTENCY_COLLISION");
    expect(effectRan).toBe(false);
    expect(fixture.repository.list()).toHaveLength(1);
  });

  it("rolls back an effect when its bounded action result is invalid", async () => {
    const fixture = await actionFixture();
    const documents = new DocumentRepository<FixtureDocument>(
      fixture.store,
      "portability_action_fixtures",
      fixtureDocumentSchema,
    );
    const projectId = ulid();
    const document = fixtureDocument(ulid());

    expect(() =>
      fixture.boundary.run(actionInput(projectId, "rollback-key"), () => {
        documents.put(document);
        return {
          ...inlineResult(projectId),
          entityIds: Array.from({ length: 51 }, () => ulid()),
        };
      }),
    ).toThrow();
    expect(documents.get(document.id)).toBeNull();
    expect(fixture.repository.list()).toEqual([]);
  });

  it("requires callers of the raw repository to own a transaction", async () => {
    const fixture = await actionFixture();
    const projectId = ulid();
    const recordedAt = fixture.options.nowIso();

    expect(() =>
      fixture.repository.recordInTransaction({
        id: ulid(),
        schemaVersion: 1,
        createdAt: recordedAt,
        updatedAt: recordedAt,
        ...actionInput(projectId, "raw-key"),
        result: inlineResult(projectId),
        recordedAt,
      }),
    ).toThrow("PORTABILITY_TRANSACTION_REQUIRED");
  });

  it("rejects a forged canonical hash through the raw repository port", async () => {
    const fixture = await actionFixture();
    const projectId = ulid();
    const recordedAt = fixture.options.nowIso();
    const input = actionInput(projectId, "raw-forged-key");

    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.repository.recordInTransaction({
          id: ulid(),
          schemaVersion: 1,
          createdAt: recordedAt,
          updatedAt: recordedAt,
          ...input,
          requestHash: hash("forged-raw-request"),
          result: inlineResult(projectId),
          recordedAt,
        }),
      ),
    ).toThrow("PORTABILITY_ACTION_REQUEST_HASH_MISMATCH");
    expect(fixture.repository.list()).toEqual([]);
  });

  it("validates the scoped key and request hash before running an effect", async () => {
    const fixture = await actionFixture();
    let effectRan = false;
    expect(() =>
      fixture.boundary.run(
        actionInput(ulid(), "invalid key with spaces"),
        () => {
          effectRan = true;
          return inlineResult(ulid());
        },
      ),
    ).toThrow();
    expect(effectRan).toBe(false);
    expect(fixture.repository.list()).toEqual([]);
  });

  it("rejects changed input paired with a caller-reused request hash", async () => {
    const fixture = await actionFixture();
    const input = actionInput(ulid(), "forged-hash");
    fixture.boundary.run(input, () => inlineResult(input.operationScope.id));
    let effectRan = false;
    const changedInput = {
      ...input,
      input: { ...input.input, counts: { documents: 999 } },
    };

    expect(() =>
      fixture.boundary.run(changedInput, () => {
        effectRan = true;
        return inlineResult(input.operationScope.id);
      }),
    ).toThrow("PORTABILITY_ACTION_REQUEST_HASH_MISMATCH");
    expect(effectRan).toBe(false);
    expect(fixture.repository.list()).toHaveLength(1);
  });
});

function actionInput(
  projectId: string,
  idempotencyKey: string,
): PortabilityActionBoundaryInput {
  const request = {
    operationScope: { kind: "project" as const, id: projectId },
    action: "export_start" as const,
    input: {
      revisions: { project: 3 },
      hashes: { inventory: hash("inventory") },
      counts: { documents: 2 },
      flags: { pauseConfirmed: true },
    },
  };
  return {
    ...request,
    idempotencyKey,
    requestHash: portabilityActionRequestHash(request),
  };
}

function inlineResult(projectId: string) {
  return {
    kind: "inline" as const,
    state: "waiting_quiescence",
    entityIds: [projectId],
    counts: { capturedAttempts: 0 },
    hashes: { operation: hash("operation") },
    flags: { projectPaused: true },
  };
}

function fixtureDocument(id: string): FixtureDocument {
  const now = "2026-07-16T10:00:00.000Z";
  return {
    id,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    value: "synthetic",
  };
}

async function actionFixture() {
  const directory = await temporaryDirectory("hekayati-actions-");
  const database = join(directory.path, "actions.db");
  const store = new DocumentStore(database);
  const options = {
    nowIso: () => "2026-07-16T10:00:00.000Z",
    idFactory: () => ulid(),
  };
  const repository = new PortabilityActionRepository(store);
  const boundary = new PortabilityActionBoundary(store, repository, options);
  const fixture = { database, store, repository, boundary, options };
  cleanups.push(async () => {
    fixture.store.close();
    await directory.cleanup();
  });
  return fixture;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
