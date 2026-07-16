import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadValidatedImportSource } from "../../src/portability/import-staging-reader.js";
import {
  IMPORT_VALIDATION_ENTITY as entity,
  cleanupImportValidationFixtures,
  harness,
  syntheticArchive,
  syntheticRegistry,
} from "../helpers/portability-import-validation-fixture.js";

afterEach(cleanupImportValidationFixtures);

describe("managed validated import source reader", () => {
  it("reconstructs and rechecks the exact normalized graph and media bytes", async () => {
    const registry = syntheticRegistry();
    const fixture = await harness(registry, await syntheticArchive());
    const operation = await fixture.validation.validate(entity.operation);

    const loaded = await loadValidatedImportSource({
      directory: fixture.managed.stagingPath(operation.stagingKey!),
      operation,
      registry,
    });

    expect(loaded.source.root).toEqual({
      projectId: entity.project,
      customerId: entity.customer,
      familyId: entity.family,
    });
    expect(loaded.source.sourceSnapshotHash).toBe(
      operation.sourceSnapshotHash,
    );
    expect(loaded.source.documents).toHaveLength(operation.documentCount);
    expect(await loaded.readMedia("asset", entity.asset)).toHaveLength(
      loaded.source.media[0].bytes,
    );
    expect(loaded.sourceProofHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when a normalized document is replaced after validation", async () => {
    const registry = syntheticRegistry();
    const fixture = await harness(registry, await syntheticArchive());
    const operation = await fixture.validation.validate(entity.operation);
    const directory = fixture.managed.stagingPath(operation.stagingKey!);
    const index = JSON.parse(
      await readFile(join(directory, "validation-index.json"), "utf8"),
    ) as { documents: Array<{ managedName: string }> };
    const target = join(directory, "normalized", index.documents[0].managedName);
    await writeFile(target, "{}", { mode: 0o600 });
    await chmod(target, 0o600);

    await expect(
      loadValidatedImportSource({ directory, operation, registry }),
    ).rejects.toThrow("IMPORT_NORMALIZED_DOCUMENT_INTEGRITY_MISMATCH");
  });
});
