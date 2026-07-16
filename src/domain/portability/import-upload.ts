import type { Readable } from "node:stream";

import { ulid } from "ulid";

import type { ManagedImportStore } from "../../portability/import.js";
import type { DocumentStore } from "../repository/document-store.js";
import {
  PortabilityActionBoundary,
  portabilityActionRequestHash,
  type PortabilityActionBoundaryInput,
} from "./operation-ledgers.js";
import type { PortabilityActionRepository } from "./repositories.js";
import { PortabilityStorageError } from "./repositories.js";
import type { PortabilityAction } from "./schemas.js";
import type { ImportOperation } from "./import-model.js";
import type { ImportOperationRepository } from "./import-storage.js";

export interface ImportUploadRequest {
  idempotencyKey: string;
  declaredArchiveHash: string;
  declaredArchiveBytes: number;
  openSource(): Readable;
}

export interface ImportUploadResult {
  result: PortabilityAction["result"];
  action: PortabilityAction;
  current: ImportOperation;
  replayed: boolean;
}

export interface ImportUploadServiceOptions {
  nowIso?: () => string;
  idFactory?: () => string;
}

export class ImportUploadService {
  readonly #boundary: PortabilityActionBoundary;
  readonly #idFactory: () => string;

  constructor(
    store: DocumentStore,
    private readonly operations: ImportOperationRepository,
    private readonly actions: PortabilityActionRepository,
    private readonly managedImports: ManagedImportStore,
    options: ImportUploadServiceOptions = {},
  ) {
    this.#idFactory = options.idFactory ?? ulid;
    this.#boundary = new PortabilityActionBoundary(store, actions, options);
  }

  async upload(request: ImportUploadRequest): Promise<ImportUploadResult> {
    const installationId = this.operations.installationId();
    const boundaryInput = importUploadBoundaryInput(installationId, request);
    const replay = this.precheckReplay(boundaryInput);
    if (replay) return replay;

    const operationId = this.#idFactory();
    const reservationKey = `${this.#idFactory()}.zip`;
    await this.managedImports.capture({
      key: reservationKey,
      declaration: {
        bytes: request.declaredArchiveBytes,
        sha256: request.declaredArchiveHash,
      },
      openSource: () => request.openSource(),
    });

    try {
      const boundary = this.#boundary.run(boundaryInput, (identity) => {
        const operation = uploadedOperation({
          operationId,
          reservationKey,
          uploadActionId: identity.id,
          sourceArchiveHash: request.declaredArchiveHash,
          sourceArchiveBytes: request.declaredArchiveBytes,
          now: identity.recordedAt,
        });
        this.operations.insertInTransaction(operation);
        return uploadActionResult(operation);
      });
      if (boundary.replayed)
        await this.managedImports.removeReservation(reservationKey);
      return this.resultFromAction(boundary.action, boundary.replayed);
    } catch (error) {
      await this.managedImports.removeReservation(reservationKey);
      throw error;
    }
  }

  private precheckReplay(
    input: PortabilityActionBoundaryInput,
  ): ImportUploadResult | null {
    const existing = this.actions.find(
      input.operationScope,
      input.action,
      input.idempotencyKey,
    );
    if (!existing) return null;
    if (existing.requestHash !== input.requestHash)
      throw new PortabilityStorageError(
        "PORTABILITY_ACTION_IDEMPOTENCY_COLLISION",
      );
    return this.resultFromAction(existing, true);
  }

  private resultFromAction(
    action: PortabilityAction,
    replayed: boolean,
  ): ImportUploadResult {
    if (action.result.kind !== "inline" || action.result.entityIds.length !== 1)
      throw new Error("IMPORT_UPLOAD_ACTION_RESULT_INVALID");
    const current = this.operations.get(action.result.entityIds[0]);
    if (!current || current.actionRefs.uploadActionId !== action.id)
      throw new Error("IMPORT_UPLOAD_ACTION_OPERATION_MISMATCH");
    return { result: action.result, action, current, replayed };
  }
}

export function importUploadBoundaryInput(
  installationId: string,
  request: Pick<
    ImportUploadRequest,
    "idempotencyKey" | "declaredArchiveHash" | "declaredArchiveBytes"
  >,
): PortabilityActionBoundaryInput {
  const input = {
    operationScope: { kind: "installation" as const, id: installationId },
    action: "import_upload" as const,
    idempotencyKey: request.idempotencyKey,
    input: {
      revisions: {},
      hashes: { archive: request.declaredArchiveHash },
      counts: { archiveBytes: request.declaredArchiveBytes },
      flags: {},
    },
  };
  return { ...input, requestHash: portabilityActionRequestHash(input) };
}

function uploadedOperation(input: {
  operationId: string;
  reservationKey: string;
  uploadActionId: string;
  sourceArchiveHash: string;
  sourceArchiveBytes: number;
  now: string;
}): ImportOperation {
  return {
    id: input.operationId,
    schemaVersion: 1,
    createdAt: input.now,
    updatedAt: input.now,
    revision: 0,
    state: "uploaded",
    reservationKey: input.reservationKey,
    stagingKey: null,
    sourceArchiveHash: input.sourceArchiveHash,
    sourceArchiveBytes: input.sourceArchiveBytes,
    manifestVersion: null,
    normalizedManifestHash: null,
    sourceSnapshotHash: null,
    participantRegistryHash: null,
    archiveMode: null,
    mode: null,
    documentCount: 0,
    mediaCount: 0,
    totalUncompressedBytes: 0,
    diskFacts: null,
    migrationSummary: null,
    actionRefs: {
      uploadActionId: input.uploadActionId,
      latestPlanActionId: null,
      commitActionId: null,
    },
    planId: null,
    commit: null,
    failureCode: null,
    cleanupState: "none",
  };
}

function uploadActionResult(
  operation: ImportOperation,
): PortabilityAction["result"] {
  return {
    kind: "inline",
    state: operation.state,
    entityIds: [operation.id],
    counts: { archiveBytes: operation.sourceArchiveBytes },
    hashes: { archive: operation.sourceArchiveHash },
    flags: { reservationAdopted: true },
  };
}
