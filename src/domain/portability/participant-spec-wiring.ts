import type { BaseDocument } from "../repository/document-store.js";
import { rewritePortabilityParticipantIds } from "./import-id-rules.js";
import { rebaseParticipantDerivedFields } from "./import-rebase.js";
import type {
  PortabilityDocumentReference,
  PortabilityMediaReference,
  PortabilityParticipantInput,
} from "./participants.js";

export interface ParticipantReferencePath {
  readonly collection: string;
  readonly path: string;
  readonly required?: boolean;
}

export interface ParticipantMediaPath {
  readonly path: string;
  readonly ownership: PortabilityMediaReference["ownership"];
}

export interface ParticipantWiringSpec {
  readonly collection: string;
  readonly projectField?: string;
  readonly customerField?: string;
  readonly owner?: readonly ParticipantReferencePath[];
  readonly refs?: readonly ParticipantReferencePath[];
  readonly assets?: readonly ParticipantMediaPath[];
  readonly originals?: readonly ParticipantMediaPath[];
  readonly extra?: Partial<PortabilityParticipantInput<BaseDocument>>;
}

export function participantRef(
  collection: string,
  path: string,
  required = true,
): ParticipantReferencePath {
  return { collection, path, required };
}

export function participantMedia(
  path: string,
  ownership: PortabilityMediaReference["ownership"] = "referenced",
): ParticipantMediaPath {
  return { path, ownership };
}

export function portabilityParticipantWiring(spec: ParticipantWiringSpec) {
  const ownerReferences =
    spec.extra?.ownerReferences ?? referencesFrom(spec.owner);
  const references = spec.extra?.references ?? referencesFrom(spec.refs);
  const ownershipReferences = referencesFrom([
    ...(spec.projectField
      ? [participantRef("projects", spec.projectField, false)]
      : []),
    ...(spec.customerField
      ? [participantRef("customers", spec.customerField, false)]
      : []),
  ]);
  const assetReferences = spec.extra?.assetReferences ?? mediaFrom(spec.assets);
  const originalReferences =
    spec.extra?.originalReferences ?? mediaFrom(spec.originals);
  return {
    ownerReferences,
    references,
    assetReferences,
    originalReferences,
    rewriteIds:
      spec.extra?.rewriteIds ??
      ((document, idMap) =>
        rewritePortabilityParticipantIds({
          collection: spec.collection,
          document,
          idMap,
          ownerReferences: ownerReferences(document),
          references: [
            ...references(document),
            ...ownershipReferences(document),
          ],
          assetReferences: assetReferences(document),
          originalReferences: originalReferences(document),
        })),
    rebaseDerivedFields:
      spec.extra?.rebaseDerivedFields ??
      ((document, idMap) =>
        rebaseParticipantDerivedFields(spec.collection, document, idMap)),
  } satisfies Partial<PortabilityParticipantInput<BaseDocument>>;
}

export function referencesFrom(
  paths: readonly ParticipantReferencePath[] | undefined,
) {
  return (document: Readonly<BaseDocument>): PortabilityDocumentReference[] =>
    (paths ?? []).flatMap((path) =>
      stringsAt(document, path.path).map((id) => ({
        collection: path.collection,
        id,
        field: path.path,
        required: path.required,
      })),
    );
}

export function mediaFrom(paths: readonly ParticipantMediaPath[] | undefined) {
  return (document: Readonly<BaseDocument>): PortabilityMediaReference[] =>
    (paths ?? []).flatMap((path) =>
      stringsAt(document, path.path).map((id) => ({
        id,
        field: path.path,
        ownership: path.ownership,
      })),
    );
}

export function idsFrom(path: string) {
  return (document: Readonly<BaseDocument>): readonly string[] =>
    stringsAt(document, path);
}

export function valueAt(
  document: Readonly<BaseDocument>,
  path: string,
): unknown {
  return valuesAt(document, path)[0];
}

export function stringsAt(
  document: Readonly<BaseDocument>,
  path: string,
): string[] {
  return valuesAt(document, path).filter(
    (value): value is string =>
      typeof value === "string" && value !== "none" && value.length > 0,
  );
}

export function valuesAt(
  document: Readonly<BaseDocument>,
  path: string,
): unknown[] {
  let values: unknown[] = [document];
  for (const segment of path.split("."))
    values = values.flatMap((value) => descend(value, segment));
  return values.filter((value) => value !== null && value !== undefined);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function descend(value: unknown, segment: string): unknown[] {
  if (segment === "*") {
    if (Array.isArray(value)) return value;
    if (isRecord(value)) return Object.values(value);
    return [];
  }
  return isRecord(value) ? [value[segment]] : [];
}
