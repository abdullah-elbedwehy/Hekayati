import { createHash } from "node:crypto";

import { canonicalJson } from "../../contracts/canonical-json.js";
import type {
  DeletionInventory,
  DeletionOperation,
  DeletionTargetKind,
} from "./deletion-model.js";
import { portabilityActionRequestHash } from "./repositories.js";
import type {
  PortabilityActionInput,
  PortabilityActionResult,
  PortabilityScope,
} from "./schemas.js";

export type CustomerCharacterDeletionDecision =
  "not_applicable" | "cascade" | "keep_pinned";

export interface DeletionConfirmationEvidence {
  target: { kind: DeletionTargetKind; id: string };
  inventoryHash: string;
  targetRevisionHash: string;
  displayName: string;
  finalConfirmation: boolean;
  customerCharacterDecision: CustomerCharacterDeletionDecision;
}

export function deletionConfirmBoundaryInput(
  idempotencyKey: string,
  inventory: DeletionInventory,
  customerCharacterDecision: CustomerCharacterDeletionDecision,
) {
  const operationScope = {
    kind: "deletion_target" as const,
    id: `${inventory.target.kind}:${inventory.target.id}`,
  };
  const action = "deletion_confirm" as const;
  const input: PortabilityActionInput = {
    revisions: {},
    hashes: {
      inventoryHash: inventory.inventoryHash,
      targetRevision: inventory.target.revisionHash,
      displayNameHash: inventory.target.displayNameHash,
      registryHash: inventory.participantRegistryHash,
    },
    counts: {
      documents: inventory.counts.documents,
      jobs: inventory.counts.jobs,
      media: inventory.counts.media,
      exports: inventory.counts.exports,
    },
    flags: {
      permanent: true,
      finalConfirmation: true,
      cascadeCustomerCharacters: customerCharacterDecision === "cascade",
    },
  };
  return boundary(operationScope, action, idempotencyKey, input);
}

export function deletionCleanupBoundaryInput(
  idempotencyKey: string,
  operation: DeletionOperation,
) {
  const operationScope = {
    kind: "deletion_operation" as const,
    id: operation.id,
  };
  const action = "deletion_cleanup_retry" as const;
  const input: PortabilityActionInput = {
    revisions: {},
    hashes: { inventoryHash: operation.inventoryHash },
    counts: {},
    flags: { retry: true },
  };
  return boundary(operationScope, action, idempotencyKey, input);
}

export function assertDeletionConfirmationTarget(
  input: DeletionConfirmationEvidence,
  inventory: DeletionInventory,
): void {
  if (
    input.target.kind !== inventory.target.kind ||
    input.target.id !== inventory.target.id ||
    input.inventoryHash !== inventory.inventoryHash ||
    input.targetRevisionHash !== inventory.target.revisionHash ||
    hash(input.displayName) !== inventory.target.displayNameHash
  )
    throw new Error("DELETION_CONFIRMATION_MISMATCH");
  if (!input.finalConfirmation)
    throw new Error("DELETION_FINAL_CONFIRMATION_REQUIRED");
  if (
    inventory.target.kind === "customer" &&
    input.customerCharacterDecision === "keep_pinned"
  )
    throw new Error("DELETION_KEEP_PINNED_ROUTE_ARCHIVE_EXPORT");
  const expectedDecision =
    inventory.target.kind === "customer" ? "cascade" : "not_applicable";
  if (input.customerCharacterDecision !== expectedDecision)
    throw new Error("DELETION_CONFIRMATION_MISMATCH");
}

export function deletionActionOperationId(
  result: PortabilityActionResult,
): string {
  if (result.kind !== "inline" || result.entityIds.length !== 1)
    throw new Error("DELETION_ACTION_RESULT_INVALID");
  return result.entityIds[0];
}

export function inlineDeletionOperationResult(
  operation: DeletionOperation,
): PortabilityActionResult {
  return {
    kind: "inline",
    state: operation.state,
    entityIds: [operation.id],
    counts: {
      documents: operation.counts.documents,
      media: operation.counts.media,
      exports: operation.counts.exports,
    },
    hashes: { inventoryHash: operation.inventoryHash },
    flags: { verified: operation.state === "verified" },
  };
}

export function deletionTargetScope(
  inventory: DeletionInventory,
): PortabilityScope {
  return inventory.target.kind === "customer"
    ? {
        kind: "customer",
        id: inventory.target.id,
        customerId: inventory.target.customerId,
      }
    : {
        kind: "project",
        id: inventory.target.id,
        projectId: inventory.target.id,
        customerId: inventory.target.customerId,
      };
}

function boundary<
  Scope extends { kind: "deletion_target" | "deletion_operation"; id: string },
  Action extends "deletion_confirm" | "deletion_cleanup_retry",
>(
  operationScope: Scope,
  action: Action,
  idempotencyKey: string,
  input: PortabilityActionInput,
) {
  return {
    operationScope,
    action,
    idempotencyKey,
    requestHash: portabilityActionRequestHash({
      operationScope,
      action,
      input,
    }),
    input,
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
