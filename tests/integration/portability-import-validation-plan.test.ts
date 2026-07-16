import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readImportValidationIndex } from "../../src/portability/import-validation-store.js";
import { rewritePortabilityParticipantIds } from "../../src/domain/portability/import-id-rules.js";
import { ImportPlanService } from "../../src/domain/portability/import-plan.js";
import { ImportPlanRepository } from "../../src/domain/portability/import-plan-storage.js";
import type { ImportPlanTargetReader } from "../../src/domain/portability/import-plan-target.js";
import { rebaseParticipantDerivedFields } from "../../src/domain/portability/import-rebase.js";
import {
  createPortabilityRegistry,
  type PortabilityRegistry,
} from "../../src/domain/portability/participants.js";
import {
  PortabilityActionRepository,
  PortabilityLedgerRepository,
} from "../../src/domain/portability/repositories.js";
import {
  IMPORT_VALIDATION_AT as at,
  IMPORT_VALIDATION_ENTITY as entity,
  cleanupImportValidationFixtures,
  harness,
  productDocumentCount,
  syntheticArchive,
  syntheticRegistry,
} from "../helpers/portability-import-validation-fixture.js";

afterEach(cleanupImportValidationFixtures);

describe("validated archive to immutable plan", () => {
  it("consumes only normalized validation facts and leaves product state empty", async () => {
    const validationRegistry = syntheticRegistry();
    const archive = await syntheticArchive();
    const fixture = await harness(validationRegistry, archive);
    const operation = await fixture.validation.validate(entity.operation);
    const registry = importReadyRegistry(validationRegistry);
    expect(registry.hash).toBe(validationRegistry.hash);
    const staging = join(fixture.managed.stagingRoot, operation.stagingKey!);
    const index = await readImportValidationIndex(staging);
    const documents = await Promise.all(
      index.documents.map(async (item) => ({
        collection: item.collection,
        id: item.id,
        schemaVersion: item.schemaVersion,
        sourceSha256: item.sourceSha256,
        normalizedSha256: item.normalizedSha256,
        migrationCount: item.migrationCount,
        document: JSON.parse(
          await readFile(join(staging, "normalized", item.managedName), "utf8"),
        ),
      })),
    );
    const plans = new ImportPlanRepository(fixture.db);
    const actions = new PortabilityActionRepository(fixture.db);
    const ledgers = new PortabilityLedgerRepository(fixture.db);
    const service = new ImportPlanService(
      fixture.db,
      fixture.operations,
      plans,
      actions,
      ledgers,
      registry,
      emptyTargetReader(),
      { nowIso: () => at, idFactory: idSequence(40) },
    );

    const result = service.plan(
      operation.id,
      {
        idempotencyKey: "validated-plan-once",
        expectedOperationRevision: operation.revision,
        mode: "as_new_project",
        sourceRoot: {
          projectId: entity.project,
          customerId: entity.customer,
          familyId: entity.family,
        },
        customerResolution: { kind: "create_from_archive" },
        replaceTarget: null,
        selectedCharacterIds: [],
        selectedTemplateIds: [],
        templateCatalogRevisionHash: null,
        explicitMappings: [],
        approvalPolicy: "demote",
      },
      {
        root: {
          projectId: entity.project,
          customerId: entity.customer,
          familyId: entity.family,
        },
        documents,
        media: index.media,
        graphHash: index.graphHash,
        sourceSnapshotHash: index.sourceSnapshotHash,
        migratedDocumentCount: index.migratedDocumentCount,
      },
    );

    expect(result.plan.counts).toMatchObject({
      mappings: 4,
      writes: 4,
      preparedMedia: 1,
    });
    expect(result.plan.ledgerRoots.preparedMedia.entryCount).toBe(1);
    expect(
      ledgers.pages(result.plan.id, "prepared_media")[0].entries,
    ).toContainEqual(
      expect.objectContaining({
        entryType: "prepared_media_intent",
        sourceId: entity.asset,
        disposition: "prepare_new",
      }),
    );
    expect(productDocumentCount(fixture.db)).toBe(0);
  });
});

function importReadyRegistry(base: PortabilityRegistry): PortabilityRegistry {
  return createPortabilityRegistry(
    base.participants.map((participant) => ({
      ...participant,
      rewriteIds: (document, idMap) =>
        rewritePortabilityParticipantIds({
          collection: participant.collection,
          document,
          idMap,
          ownerReferences: participant.ownerReferences(document),
          references: participant.references(document),
          assetReferences: participant.assetReferences(document),
          originalReferences: participant.originalReferences(document),
        }),
      rebaseDerivedFields: (document, idMap) =>
        rebaseParticipantDerivedFields(participant.collection, document, idMap),
    })),
    base.catalog,
  );
}

function emptyTargetReader(): ImportPlanTargetReader {
  return {
    document: () => null,
    revisionHash: () => null,
    idExists: () => false,
    findExactMedia: () => null,
    templateCatalogRevisionHash: () => "0".repeat(64),
  };
}

function idSequence(start: number): () => string {
  let value = start;
  return () => id(value++);
}

function id(value: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `01K70000000000000000000000`
    .slice(0, 24)
    .concat(alphabet[Math.floor(value / 32)], alphabet[value % 32]);
}
