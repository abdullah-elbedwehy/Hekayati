import type { BaseDocument } from "../repository/document-store.js";
import {
  portabilityMediaHoldSchema,
  portabilitySnapshotEntrySchema,
  portabilitySnapshotSchema,
} from "./export-model.js";
import {
  definePortabilityParticipant,
  type PortabilityDocumentReference,
  type PortabilityParticipant,
} from "./participants.js";
import {
  portabilityActionSchema,
  portabilityLedgerPageSchema,
  type PortabilityAction,
  type PortabilityLedgerPage,
} from "./schemas.js";

export const exportInternalOwnershipParticipants: readonly PortabilityParticipant[] =
  Object.freeze([
    definePortabilityParticipant({
      key: "portability_snapshots",
      collection: "portability_snapshots",
      currentSchemaVersion: 1,
      schema: portabilitySnapshotSchema,
      dependencies: ["export_operations"],
      exportModes: [],
      projectIds: directIds("projectId"),
      customerIds: directIds("customerId"),
      ownerReferences: (document) => {
        const snapshot = portabilitySnapshotSchema.parse(document);
        return [
          owner("export_operations", snapshot.operationId, "operationId"),
        ];
      },
    }),
    definePortabilityParticipant({
      key: "portability_snapshot_entries",
      collection: "portability_snapshot_entries",
      currentSchemaVersion: 1,
      schema: portabilitySnapshotEntrySchema,
      dependencies: ["portability_snapshots"],
      exportModes: [],
      ownerReferences: (document) => {
        const entry = portabilitySnapshotEntrySchema.parse(document);
        return [owner("portability_snapshots", entry.snapshotId, "snapshotId")];
      },
    }),
    definePortabilityParticipant({
      key: "portability_media_holds",
      collection: "portability_media_holds",
      currentSchemaVersion: 1,
      schema: portabilityMediaHoldSchema,
      dependencies: ["portability_snapshots"],
      exportModes: [],
      ownerReferences: (document) => {
        const hold = portabilityMediaHoldSchema.parse(document);
        return [owner("portability_snapshots", hold.snapshotId, "snapshotId")];
      },
      assetReferences: (document) => {
        const hold = portabilityMediaHoldSchema.parse(document);
        return hold.namespace === "asset" && hold.state === "held"
          ? [{ id: hold.mediaId, field: "mediaId", ownership: "owned" }]
          : [];
      },
      originalReferences: (document) => {
        const hold = portabilityMediaHoldSchema.parse(document);
        return hold.namespace === "original" && hold.state === "held"
          ? [{ id: hold.mediaId, field: "mediaId", ownership: "owned" }]
          : [];
      },
    }),
    definePortabilityParticipant({
      key: "portability_actions",
      collection: "portability_actions",
      currentSchemaVersion: 1,
      schema: portabilityActionSchema,
      dependencies: ["projects"],
      exportModes: [],
      projectIds: exportActionProjectIds,
      ownerReferences: exportActionOwnerReferences,
    }),
    definePortabilityParticipant({
      key: "portability_ledger_pages",
      collection: "portability_ledger_pages",
      currentSchemaVersion: 1,
      schema: portabilityLedgerPageSchema,
      dependencies: ["export_operations"],
      exportModes: [],
      ownerReferences: exportLedgerOwnerReferences,
    }),
  ]);

function exportActionProjectIds(
  document: Readonly<BaseDocument>,
): readonly string[] {
  const action = document as PortabilityAction;
  return action.action === "export_pause" || action.action === "export_start"
    ? [action.operationScope.id]
    : [];
}

function exportActionOwnerReferences(
  document: Readonly<BaseDocument>,
): readonly PortabilityDocumentReference[] {
  return exportActionProjectIds(document).map((id) =>
    owner("projects", id, "operationScope.id"),
  );
}

function exportLedgerOwnerReferences(
  document: Readonly<BaseDocument>,
): readonly PortabilityDocumentReference[] {
  const page = document as PortabilityLedgerPage;
  if (
    page.ledgerKind !== "captured_attempts" &&
    page.ledgerKind !== "snapshot_index"
  )
    return [];
  return [owner("export_operations", page.operationId, "operationId", false)];
}

function directIds(field: string) {
  return (document: Readonly<BaseDocument>): readonly string[] => {
    const value = (document as Readonly<Record<string, unknown>>)[field];
    return typeof value === "string" ? [value] : [];
  };
}

function owner(
  collection: string,
  id: string,
  field: string,
  required = true,
): PortabilityDocumentReference {
  return { collection, id, field, required };
}
