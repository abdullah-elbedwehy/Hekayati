import { createHash } from "node:crypto";

import { canonicalJson } from "../../contracts/canonical-json.js";
import { entityIdSchema } from "../library/schemas.js";
import type { BaseDocument } from "../repository/document-store.js";
import type {
  ExactIdMap,
  PortabilityDocumentReference,
  PortabilityMediaReference,
} from "./participants.js";

const separator = "\0";
const namespacePattern = /^[a-z][a-z0-9_]{0,79}$/;

export interface ExactIdMapping {
  namespace: string;
  sourceId: string;
  targetId: string;
}

export interface ParticipantDocumentRewriteInput<
  T extends BaseDocument = BaseDocument,
> {
  collection: string;
  document: Readonly<T>;
  idMap: ExactIdMap;
  documentReferences: readonly PortabilityDocumentReference[];
  assetReferences: readonly PortabilityMediaReference[];
  originalReferences: readonly PortabilityMediaReference[];
}

export function namespacedIdKey(namespace: string, sourceId: string): string {
  if (!namespacePattern.test(namespace))
    throw new Error("IMPORT_ID_MAP_NAMESPACE_INVALID");
  entityIdSchema.parse(sourceId);
  return `${namespace}${separator}${sourceId}`;
}

export function createExactIdMap(
  mappings: readonly ExactIdMapping[],
): ExactIdMap {
  const values = new Map<string, string>();
  for (const mapping of orderedMappings(mappings)) {
    entityIdSchema.parse(mapping.targetId);
    const key = namespacedIdKey(mapping.namespace, mapping.sourceId);
    const existing = values.get(key);
    if (existing && existing !== mapping.targetId)
      throw new Error("IMPORT_ID_MAP_SOURCE_CONFLICT");
    values.set(key, mapping.targetId);
  }
  return new ImmutableExactIdMap(values);
}

export function exactIdMappings(idMap: ExactIdMap): ExactIdMapping[] {
  const result: ExactIdMapping[] = [];
  for (const [key, targetId] of idMap) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    entityIdSchema.parse(targetId);
    result.push({ ...parsed, targetId });
  }
  return orderedMappings(result);
}

export function exactIdMapHash(idMap: ExactIdMap): string {
  return createHash("sha256")
    .update("HekayatiExactIdMap/v1\n")
    .update(canonicalJson(exactIdMappings(idMap)))
    .digest("hex");
}

export function lookupExactId(
  idMap: ExactIdMap,
  namespace: string | null,
  sourceId: string,
): string | null {
  if (namespace) {
    const target = idMap.get(
      namespacedIdKey(normalizedNamespace(namespace), sourceId),
    );
    return target ?? null;
  }
  const targets = new Set(
    exactIdMappings(idMap)
      .filter((mapping) => mapping.sourceId === sourceId)
      .map((mapping) => mapping.targetId),
  );
  if (targets.size > 1) throw new Error("IMPORT_ID_MAP_NAMESPACE_AMBIGUOUS");
  return [...targets][0] ?? null;
}

export function rewriteParticipantDocumentIds<
  T extends BaseDocument = BaseDocument,
>(input: ParticipantDocumentRewriteInput<T>): T {
  const rewritten = clone(input.document) as T;
  replaceRequired(
    rewritten,
    "id",
    input.document.id,
    requiredTarget(
      input.idMap,
      entityNamespace(input.collection),
      input.document.id,
    ),
  );
  for (const reference of input.documentReferences)
    rewriteDocumentReference(rewritten, input.idMap, reference);
  for (const reference of input.assetReferences)
    rewriteMediaReference(rewritten, input.idMap, reference, "asset");
  for (const reference of input.originalReferences)
    rewriteMediaReference(rewritten, input.idMap, reference, "original");
  return rewritten;
}

export function rewriteExplicitIdPath(
  document: BaseDocument,
  path: string,
  idMap: ExactIdMap,
  namespace: string | null,
  required = true,
): number {
  let rewritten = 0;
  mapAtPath(document, path.split("."), (value) => {
    if (typeof value !== "string" || !isEntityId(value)) return value;
    const target = lookupExactId(idMap, namespace, value);
    if (!target) {
      if (isExactTarget(idMap, namespace, value)) {
        rewritten += 1;
        return value;
      }
      if (required) throw new Error("IMPORT_ID_MAP_REQUIRED_MAPPING_MISSING");
      return value;
    }
    rewritten += 1;
    return target;
  });
  return rewritten;
}

function isExactTarget(
  idMap: ExactIdMap,
  namespace: string | null,
  value: string,
): boolean {
  return exactIdMappings(idMap).some(
    (mapping) =>
      mapping.targetId === value &&
      (namespace === null ||
        mapping.namespace === normalizedNamespace(namespace)),
  );
}

export function valuesAtExplicitPath(
  document: Readonly<BaseDocument>,
  path: string,
): string[] {
  let values: unknown[] = [document];
  for (const segment of path.split("."))
    values = values.flatMap((value) => descend(value, segment));
  return values.filter(
    (value): value is string => typeof value === "string" && isEntityId(value),
  );
}

export function assertNoUnmappedArchiveIds(
  value: unknown,
  idMap: ExactIdMap,
): void {
  const stale = new Set(
    exactIdMappings(idMap)
      .filter((mapping) => mapping.sourceId !== mapping.targetId)
      .map((mapping) => mapping.sourceId),
  );
  visitStrings(value, (text) => {
    if ([...stale].some((sourceId) => text.includes(sourceId)))
      throw new Error("IMPORT_UNDECLARED_ARCHIVE_ID_RETAINED");
  });
}

export function entityNamespace(collection: string): string {
  return normalizedNamespace(collection);
}

function rewriteDocumentReference(
  document: BaseDocument,
  idMap: ExactIdMap,
  reference: PortabilityDocumentReference,
): void {
  const target = lookupExactId(
    idMap,
    entityNamespace(reference.collection),
    reference.id,
  );
  if (!target) {
    if (reference.required !== false)
      throw new Error("IMPORT_ID_MAP_REQUIRED_MAPPING_MISSING");
    return;
  }
  const count = replaceAtPath(document, reference.field, reference.id, target);
  if (count === 0 && reference.required !== false)
    throw new Error("IMPORT_DECLARED_ID_FIELD_MISSING");
}

function rewriteMediaReference(
  document: BaseDocument,
  idMap: ExactIdMap,
  reference: PortabilityMediaReference,
  namespace: "asset" | "original",
): void {
  const target = requiredTarget(idMap, namespace, reference.id);
  if (replaceAtPath(document, reference.field, reference.id, target) === 0)
    throw new Error("IMPORT_DECLARED_ID_FIELD_MISSING");
}

function requiredTarget(
  idMap: ExactIdMap,
  namespace: string,
  sourceId: string,
): string {
  const target = lookupExactId(idMap, namespace, sourceId);
  if (!target) throw new Error("IMPORT_ID_MAP_REQUIRED_MAPPING_MISSING");
  return target;
}

function replaceRequired(
  document: BaseDocument,
  path: string,
  sourceId: string,
  targetId: string,
): void {
  if (replaceAtPath(document, path, sourceId, targetId) !== 1)
    throw new Error("IMPORT_DECLARED_ID_FIELD_MISSING");
}

function replaceAtPath(
  document: BaseDocument,
  path: string,
  sourceId: string,
  targetId: string,
): number {
  let replaced = 0;
  let alreadyTarget = false;
  mapAtPath(document, path.split("."), (value) => {
    if (value === sourceId) {
      replaced += 1;
      return targetId;
    }
    if (value === targetId) alreadyTarget = true;
    return value;
  });
  return replaced + (alreadyTarget ? 1 : 0);
}

function mapAtPath(
  value: unknown,
  segments: readonly string[],
  transform: (value: unknown) => unknown,
): void {
  if (segments.length === 0) return;
  const [segment, ...rest] = segments;
  if (rest.length === 0) {
    for (const target of targets(value, segment))
      writeTarget(target, transform(readTarget(target)));
    return;
  }
  for (const target of targets(value, segment))
    mapAtPath(readTarget(target), rest, transform);
}

function targets(
  value: unknown,
  segment: string,
): Array<{
  parent: Record<string, unknown> | unknown[];
  key: string | number;
}> {
  if (segment === "*") {
    if (Array.isArray(value))
      return value.map((_, key) => ({ parent: value, key }));
    if (isRecord(value))
      return Object.keys(value).map((key) => ({ parent: value, key }));
    return [];
  }
  if (Array.isArray(value) && /^[0-9]+$/.test(segment)) {
    const key = Number(segment);
    return key < value.length ? [{ parent: value, key }] : [];
  }
  return isRecord(value) && Object.hasOwn(value, segment)
    ? [{ parent: value, key: segment }]
    : [];
}

function descend(value: unknown, segment: string): unknown[] {
  if (segment === "*") {
    if (Array.isArray(value)) return value;
    if (isRecord(value)) return Object.values(value);
    return [];
  }
  if (Array.isArray(value) && /^[0-9]+$/.test(segment))
    return [value[Number(segment)]];
  return isRecord(value) ? [value[segment]] : [];
}

type PathTarget = {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
};

function readTarget(target: PathTarget): unknown {
  return (target.parent as Record<string | number, unknown>)[target.key];
}

function writeTarget(target: PathTarget, value: unknown): void {
  (target.parent as Record<string | number, unknown>)[target.key] = value;
}

function visitStrings(value: unknown, visit: (value: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, visit);
    return;
  }
  if (isRecord(value))
    for (const item of Object.values(value)) visitStrings(item, visit);
}

function normalizedNamespace(namespace: string): string {
  if (namespace === "assets") return "asset";
  if (namespace === "original_assets") return "original";
  return namespace;
}

function orderedMappings(
  mappings: readonly ExactIdMapping[],
): ExactIdMapping[] {
  return [...mappings].sort(
    (left, right) =>
      left.namespace.localeCompare(right.namespace) ||
      left.sourceId.localeCompare(right.sourceId) ||
      left.targetId.localeCompare(right.targetId),
  );
}

function parseKey(
  key: string,
): Pick<ExactIdMapping, "namespace" | "sourceId"> | null {
  const index = key.indexOf(separator);
  if (index < 1) return null;
  const namespace = key.slice(0, index);
  const sourceId = key.slice(index + 1);
  if (!namespacePattern.test(namespace) || !isEntityId(sourceId)) return null;
  return { namespace, sourceId };
}

function isEntityId(value: string): boolean {
  return entityIdSchema.safeParse(value).success;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ImmutableExactIdMap implements ExactIdMap {
  readonly #values: ReadonlyMap<string, string>;

  constructor(values: ReadonlyMap<string, string>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: string): string | undefined {
    return this.#values.get(key);
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[string, string]> {
    return this.#values.entries();
  }

  keys(): MapIterator<string> {
    return this.#values.keys();
  }

  values(): MapIterator<string> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (
      value: string,
      key: string,
      map: ReadonlyMap<string, string>,
    ) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value, key) =>
      callbackfn.call(thisArg, value, key, this),
    );
  }

  [Symbol.iterator](): MapIterator<[string, string]> {
    return this.entries();
  }
}
