import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { CapturedAttemptLedger } from "../../src/domain/portability/operation-ledgers.js";
import {
  PortabilityLedgerRepository,
  hashLedgerPage,
} from "../../src/domain/portability/repositories.js";
import {
  PORTABILITY_LEDGER_PAGE_SIZE,
  portabilityLedgerPageSchema,
} from "../../src/domain/portability/schemas.js";
import { temporaryDirectory } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("bounded portability storage ledgers", () => {
  it("persists deterministic captured-attempt pages and roots", async () => {
    const fixture = await ledgerFixture();
    const operationId = ulid();
    const attempts = Array.from({ length: 300 }, (_, index) => ({
      jobId: ulid(),
      attempt: (index % 3) + 1,
    })).reverse();

    const first = fixture.captured.write(operationId, attempts);
    expect(first).toMatchObject({
      operationId,
      ledgerKind: "captured_attempts",
      pageCount: 2,
      entryCount: 300,
    });
    const pages = fixture.repository.pages(operationId, "captured_attempts");
    expect(pages.map((page) => page.entries.length)).toEqual([256, 44]);
    expect(
      pages
        .flatMap((page) => page.entries)
        .map((entry) =>
          entry.entryType === "job_attempt"
            ? `${entry.jobId}:${entry.attempt}`
            : "invalid",
        ),
    ).toEqual(
      [...attempts]
        .sort(
          (left, right) =>
            left.jobId.localeCompare(right.jobId) ||
            left.attempt - right.attempt,
        )
        .map((entry) => `${entry.jobId}:${entry.attempt}`),
    );
    expect(fixture.captured.write(operationId, attempts)).toEqual(first);
    expect(fixture.captured.has(operationId, attempts[0].jobId, 1)).toBe(
      attempts[0].attempt === 1,
    );

    fixture.store.close();
    const reopened = new DocumentStore(fixture.database);
    try {
      expect(
        new PortabilityLedgerRepository(reopened).root(
          operationId,
          "captured_attempts",
        ),
      ).toEqual(first);
    } finally {
      reopened.close();
    }
  });

  it("rejects duplicate attempts and rolls back partial replacement pages", async () => {
    const fixture = await ledgerFixture();
    const operationId = ulid();
    const jobId = ulid();
    expect(() =>
      fixture.captured.write(operationId, [
        { jobId, attempt: 1 },
        { jobId, attempt: 1 },
      ]),
    ).toThrow("PORTABILITY_LEDGER_PAGE_CONFLICT");
    expect(fixture.repository.pages(operationId, "captured_attempts")).toEqual(
      [],
    );

    const original = Array.from({ length: 300 }, () => ({
      jobId: ulid(),
      attempt: 1,
    }));
    fixture.captured.write(operationId, original);
    const changed = [...original];
    changed[299] = { jobId: ulid(), attempt: 1 };
    expect(() => fixture.captured.write(operationId, changed)).toThrow(
      "PORTABILITY_LEDGER_PAGE_CONFLICT",
    );
    expect(fixture.repository.root(operationId, "captured_attempts")).toEqual(
      fixture.captured.write(operationId, original),
    );
  });

  it("requires transaction ownership and verifies every page hash", async () => {
    const fixture = await ledgerFixture();
    const operationId = ulid();
    const entry = documentEntry();
    const page = {
      id: ulid(),
      schemaVersion: 1 as const,
      createdAt: fixture.now,
      updatedAt: fixture.now,
      operationId,
      ledgerKind: "snapshot_index" as const,
      pageIndex: 0,
      entries: [entry],
      pageHash: hash("wrong-page"),
    };

    expect(() => fixture.repository.appendPageInTransaction(page)).toThrow(
      "PORTABILITY_TRANSACTION_REQUIRED",
    );
    expect(() =>
      fixture.store.transactionImmediate(() =>
        fixture.repository.appendPageInTransaction(page),
      ),
    ).toThrow("PORTABILITY_LEDGER_PAGE_HASH_MISMATCH");
    expect(fixture.repository.pages(operationId, "snapshot_index")).toEqual([]);

    const valid = {
      ...page,
      pageHash: hashLedgerPage(page),
    };
    fixture.store.transactionImmediate(() =>
      fixture.repository.appendPageInTransaction(valid),
    );
    expect(fixture.repository.page(operationId, "snapshot_index", 0)).toEqual(
      valid,
    );
  });

  it("rejects pages larger than the closed 256-entry bound", () => {
    const operationId = ulid();
    const entries = Array.from(
      { length: PORTABILITY_LEDGER_PAGE_SIZE + 1 },
      documentEntry,
    );
    expect(
      portabilityLedgerPageSchema.safeParse({
        id: ulid(),
        schemaVersion: 1,
        createdAt: "2026-07-16T10:00:00.000Z",
        updatedAt: "2026-07-16T10:00:00.000Z",
        operationId,
        ledgerKind: "snapshot_index",
        pageIndex: 0,
        entries,
        pageHash: hash("oversized"),
      }).success,
    ).toBe(false);

    expect(
      portabilityLedgerPageSchema.safeParse({
        id: ulid(),
        schemaVersion: 1,
        createdAt: "2026-07-16T10:00:00.000Z",
        updatedAt: "2026-07-16T10:00:00.000Z",
        operationId,
        ledgerKind: "captured_attempts",
        pageIndex: 0,
        entries: [
          {
            entryType: "job_attempt",
            jobId: ulid(),
            attempt: 1,
          },
          documentEntry(),
        ],
        pageHash: hash("mixed"),
      }).success,
    ).toBe(false);
  });
});

function documentEntry() {
  return {
    entryType: "document" as const,
    collection: "projects",
    documentId: ulid(),
    reasonCode: "root_project",
    schemaVersion: 2,
    bytes: 512,
    sha256: hash("document"),
  };
}

async function ledgerFixture() {
  const directory = await temporaryDirectory("hekayati-ledgers-");
  const database = join(directory.path, "ledgers.db");
  const store = new DocumentStore(database);
  const now = "2026-07-16T10:00:00.000Z";
  const repository = new PortabilityLedgerRepository(store);
  const captured = new CapturedAttemptLedger(store, repository, {
    nowIso: () => now,
    idFactory: ulid,
  });
  cleanups.push(async () => {
    store.close();
    await directory.cleanup();
  });
  return { database, store, repository, captured, now };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
