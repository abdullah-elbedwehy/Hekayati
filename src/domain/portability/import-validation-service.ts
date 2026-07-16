import { ulid } from "ulid";

import type { SecretReleaseGate } from "../../portability/secret-scan.js";
import {
  type ManagedImportStore,
  type ImportReconciliationResult,
} from "../../portability/import.js";
import {
  preflightImportDisk,
  type ImportDiskProbeInput,
} from "../../portability/disk-preflight.js";
import { writeImportValidationBundle } from "../../portability/import-validation-store.js";
import { stageImportArchive } from "../../portability/zip-reader.js";
import type { DocumentStore } from "../repository/document-store.js";
import { validateStagedImport } from "./import-validation.js";
import type { ImportDiskFacts, ImportOperation } from "./import-model.js";
import type { ImportOperationRepository } from "./import-storage.js";
import type { PortabilityRegistry } from "./participants.js";

export interface ImportValidationServiceOptions {
  reserveBytes: number;
  nowIso?: () => string;
  idFactory?: () => string;
  diskPreflight?: (input: ImportDiskProbeInput) => Promise<ImportDiskFacts>;
}

export class ImportValidationService {
  readonly #nowIso: () => string;
  readonly #idFactory: () => string;
  readonly #diskPreflight: NonNullable<
    ImportValidationServiceOptions["diskPreflight"]
  >;
  readonly #inFlight = new Map<string, Promise<ImportOperation>>();

  constructor(
    private readonly store: DocumentStore,
    private readonly operations: ImportOperationRepository,
    private readonly registry: PortabilityRegistry,
    private readonly managedImports: ManagedImportStore,
    private readonly secretGate: SecretReleaseGate,
    private readonly options: ImportValidationServiceOptions,
  ) {
    this.#nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? ulid;
    this.#diskPreflight = options.diskPreflight ?? preflightImportDisk;
  }

  validate(operationId: string): Promise<ImportOperation> {
    const existing = this.#inFlight.get(operationId);
    if (existing) return existing;
    const started = this.validateOnce(operationId).finally(() => {
      this.#inFlight.delete(operationId);
    });
    this.#inFlight.set(operationId, started);
    return started;
  }

  async recover(): Promise<{
    reconciliation: ImportReconciliationResult;
    resumed: readonly string[];
    cleanupRetried: readonly string[];
  }> {
    const reconciliation = await this.managedImports.reconcile({
      referencedReservations: this.operations.referencedReservationKeys(),
      referencedStaging: this.operations.referencedStagingKeys(),
    });
    const resumed: string[] = [];
    const cleanupRetried: string[] = [];
    for (const operation of this.operations.list()) {
      if (operation.state === "validating") {
        await this.validate(operation.id);
        resumed.push(operation.id);
      } else if (operation.state === "cleanup_required") {
        await this.retryCleanup(operation);
        cleanupRetried.push(operation.id);
      }
    }
    return {
      reconciliation,
      resumed: Object.freeze(resumed),
      cleanupRetried: Object.freeze(cleanupRetried),
    };
  }

  private async validateOnce(operationId: string): Promise<ImportOperation> {
    let operation = this.requireOperation(operationId);
    if (operation.state === "plan_ready") return operation;
    if (operation.state === "cleanup_required") {
      await this.retryCleanup(operation);
      throw new Error("IMPORT_VALIDATION_PREVIOUSLY_FAILED");
    }
    if (operation.state === "failed")
      throw new Error(operation.failureCode ?? "IMPORT_VALIDATION_FAILED");
    if (operation.state === "uploaded") operation = this.begin(operation);
    if (operation.state !== "validating" || !operation.stagingKey)
      throw new Error("IMPORT_VALIDATION_STATE_INVALID");
    try {
      await this.managedImports.removeStaging(operation.stagingKey);
      await this.managedImports.verifyReservation(
        requiredReservation(operation),
        sourceDeclaration(operation),
      );
      let firstDiskFacts: ImportDiskFacts | null = null;
      const staged = await stageImportArchive({
        sourcePath: this.managedImports.reservationPath(
          requiredReservation(operation),
        ),
        stagingRoot: this.managedImports.stagingRoot,
        stagingKey: operation.stagingKey,
        secretGate: this.secretGate,
        preflight: async (facts) => {
          firstDiskFacts = await this.preflight(facts);
        },
      });
      if (!firstDiskFacts) throw new Error("IMPORT_DISK_PREFLIGHT_MISSING");
      const validated = await validateStagedImport({
        registry: this.registry,
        archive: staged,
      });
      await writeImportValidationBundle(staged.directory, validated);
      const finalDiskFacts = await this.preflight({
        declaredUncompressedBytes: staged.manifest.totalUncompressedBytes,
        canonicalDocumentBytes: staged.canonicalDocumentBytes,
        newContentBytes: staged.newContentBytes,
      });
      return this.finish(operation, staged, validated, finalDiskFacts);
    } catch (error) {
      await this.failAndClean(operation, error);
      throw error;
    }
  }

  private begin(operation: ImportOperation): ImportOperation {
    return this.store.transactionImmediate(() =>
      this.operations.replaceInTransaction(
        {
          ...operation,
          revision: operation.revision + 1,
          updatedAt: this.#nowIso(),
          state: "validating",
          stagingKey: this.#idFactory(),
        },
        operation.revision,
      ),
    );
  }

  private finish(
    operation: ImportOperation,
    staged: Awaited<ReturnType<typeof stageImportArchive>>,
    validated: Awaited<ReturnType<typeof validateStagedImport>>,
    diskFacts: ImportDiskFacts,
  ): ImportOperation {
    return this.store.transactionImmediate(() => {
      const current = this.requireOperation(operation.id);
      if (
        current.state !== "validating" ||
        current.revision !== operation.revision ||
        current.stagingKey !== staged.stagingKey
      )
        throw new Error("IMPORT_OPERATION_REVISION_CONFLICT");
      return this.operations.replaceInTransaction(
        {
          ...current,
          revision: current.revision + 1,
          updatedAt: this.#nowIso(),
          state: "plan_ready",
          manifestVersion: staged.sourceVersion,
          normalizedManifestHash: staged.manifest.manifestHash,
          sourceSnapshotHash: validated.sourceSnapshotHash,
          participantRegistryHash: this.registry.hash,
          archiveMode: staged.manifest.mode,
          documentCount: staged.manifest.documents.length,
          mediaCount: staged.manifest.media.length,
          totalUncompressedBytes: staged.manifest.totalUncompressedBytes,
          diskFacts,
          migrationSummary: {
            sourceManifestVersion: staged.sourceVersion,
            normalizedManifestVersion: 2,
            migratedManifest: staged.migrated,
            migratedDocumentCount: validated.migratedDocumentCount,
          },
        },
        current.revision,
      );
    });
  }

  private async failAndClean(
    operation: ImportOperation,
    error: unknown,
  ): Promise<void> {
    const failureCode = boundedFailureCode(error);
    let cleanupFailed = false;
    try {
      if (operation.stagingKey)
        await this.managedImports.removeStaging(operation.stagingKey);
      if (operation.reservationKey)
        await this.managedImports.removeReservation(operation.reservationKey);
    } catch {
      cleanupFailed = true;
    }
    this.store.transactionImmediate(() => {
      const current = this.requireOperation(operation.id);
      if (current.state !== "validating") return;
      this.operations.replaceInTransaction(
        {
          ...current,
          revision: current.revision + 1,
          updatedAt: this.#nowIso(),
          state: cleanupFailed ? "cleanup_required" : "failed",
          reservationKey: cleanupFailed ? current.reservationKey : null,
          stagingKey: cleanupFailed ? current.stagingKey : null,
          failureCode,
          cleanupState: cleanupFailed ? "failed" : "complete",
        },
        current.revision,
      );
    });
  }

  private async retryCleanup(operation: ImportOperation): Promise<void> {
    if (operation.stagingKey)
      await this.managedImports.removeStaging(operation.stagingKey);
    if (operation.reservationKey)
      await this.managedImports.removeReservation(operation.reservationKey);
    this.store.transactionImmediate(() => {
      const current = this.requireOperation(operation.id);
      if (current.state !== "cleanup_required") return;
      this.operations.replaceInTransaction(
        {
          ...current,
          revision: current.revision + 1,
          updatedAt: this.#nowIso(),
          state: "failed",
          reservationKey: null,
          stagingKey: null,
          cleanupState: "complete",
        },
        current.revision,
      );
    });
  }

  private preflight(
    input: Omit<ImportDiskProbeInput, "root" | "reserveBytes">,
  ): Promise<ImportDiskFacts> {
    return this.#diskPreflight({
      root: this.managedImports.root,
      reserveBytes: this.options.reserveBytes,
      ...input,
    });
  }

  private requireOperation(id: string): ImportOperation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error("IMPORT_OPERATION_NOT_FOUND");
    return operation;
  }
}

function requiredReservation(operation: ImportOperation): string {
  if (!operation.reservationKey) throw new Error("IMPORT_RESERVATION_MISSING");
  return operation.reservationKey;
}

function sourceDeclaration(operation: ImportOperation) {
  return {
    bytes: operation.sourceArchiveBytes,
    sha256: operation.sourceArchiveHash,
  };
}

function boundedFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.message))
    return error.message;
  return "IMPORT_VALIDATION_FAILED";
}
