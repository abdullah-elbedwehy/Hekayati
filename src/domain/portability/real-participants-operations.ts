import type { BaseDocument } from "../repository/document-store.js";
import { exportOperationSchema, managedExportSchema } from "./export-model.js";
import {
  definePortabilityParticipant,
  type PortabilityParticipant,
} from "./participants.js";

export const operationOwnershipParticipants: readonly PortabilityParticipant[] =
  Object.freeze([
    operationParticipant("export_operations", exportOperationSchema),
    operationParticipant("managed_exports", managedExportSchema, [
      "export_operations",
    ]),
  ]);

function operationParticipant(
  key: "export_operations" | "managed_exports",
  schema: typeof exportOperationSchema | typeof managedExportSchema,
  dependencies: readonly string[] = ["projects"],
): PortabilityParticipant {
  return definePortabilityParticipant({
    key,
    collection: key,
    currentSchemaVersion: 1,
    schema,
    dependencies,
    exportModes: ["customer"],
    projectIds: directIds("projectId"),
    customerIds: directIds("customerId"),
    selectForProject: (document, root) =>
      directIds("projectId")(document).includes(root.projectId)
        ? `owned_project:${root.projectId}`
        : null,
    selectForCustomer: (document, root) =>
      directIds("customerId")(document).includes(root.customerId)
        ? `owned_customer:${root.customerId}`
        : null,
    ownerReferences: (document) =>
      key === "export_operations"
        ? directIds("projectId")(document).map((id) => ({
            collection: "projects",
            id,
            field: "projectId",
          }))
        : directIds("operationId")(document).map((id) => ({
            collection: "export_operations",
            id,
            field: "operationId",
          })),
  });
}

function directIds(field: "projectId" | "customerId" | "operationId") {
  return (document: Readonly<BaseDocument>): readonly string[] => {
    const value = (document as Readonly<Record<string, unknown>>)[field];
    return typeof value === "string" ? [value] : [];
  };
}
