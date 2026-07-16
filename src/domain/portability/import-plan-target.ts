import { createHash } from "node:crypto";

import { canonicalJson } from "../../contracts/canonical-json.js";
import type {
  BaseDocument,
  DocumentStore,
} from "../repository/document-store.js";
import type { PortabilityValidatedMediaFacts } from "./participants.js";

export interface ImportExactMediaTarget {
  readonly id: string;
  readonly revisionHash: string;
}

export interface ImportPlanTargetReader {
  document(collection: string, id: string): Readonly<BaseDocument> | null;
  revisionHash(collection: string, id: string): string | null;
  idExists(namespace: string, id: string): boolean;
  findExactMedia(
    facts: PortabilityValidatedMediaFacts,
    sourceDocument: Readonly<BaseDocument> | null,
  ): ImportExactMediaTarget | null;
  templateCatalogRevisionHash(): string;
}

export class DocumentStoreImportPlanTargetReader implements ImportPlanTargetReader {
  constructor(private readonly store: DocumentStore) {}

  document(collection: string, id: string): Readonly<BaseDocument> | null {
    const row = this.store.database
      .prepare("SELECT doc FROM documents WHERE collection = ? AND id = ?")
      .get(collection, id) as { doc: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.doc) as BaseDocument;
    this.store.assertSafeForPersistence(parsed);
    return parsed;
  }

  revisionHash(collection: string, id: string): string | null {
    const document = this.document(collection, id);
    return document ? hashCanonical(document) : null;
  }

  idExists(namespace: string, id: string): boolean {
    const collection = namespaceCollection(namespace);
    if (collection) return this.document(collection, id) !== null;
    const row = this.store.database
      .prepare("SELECT 1 AS present FROM documents WHERE id = ? LIMIT 1")
      .get(id) as { present: number } | undefined;
    return row !== undefined;
  }

  findExactMedia(
    facts: PortabilityValidatedMediaFacts,
    sourceDocument: Readonly<BaseDocument> | null,
  ): ImportExactMediaTarget | null {
    if (!sourceDocument) return null;
    const collection =
      facts.namespace === "asset" ? "assets" : "original_assets";
    const rows = this.store.database
      .prepare("SELECT doc FROM documents WHERE collection = ? ORDER BY id")
      .all(collection) as Array<{ doc: string }>;
    const sourceMetadata = canonicalMediaMetadata(facts, sourceDocument);
    for (const row of rows) {
      const candidate = JSON.parse(row.doc) as BaseDocument;
      if (!mediaRecordMatchesFacts(candidate, facts)) continue;
      if (canonicalMediaMetadata(facts, candidate) !== sourceMetadata) continue;
      return { id: candidate.id, revisionHash: hashCanonical(candidate) };
    }
    return null;
  }

  templateCatalogRevisionHash(): string {
    const rows = this.store.database
      .prepare(
        `SELECT collection, doc FROM documents
         WHERE collection IN ('story_templates', 'story_template_versions')
         ORDER BY collection, id`,
      )
      .all() as Array<{ collection: string; doc: string }>;
    return hashCanonical(
      rows.map((row) => ({
        collection: row.collection,
        document: JSON.parse(row.doc) as BaseDocument,
      })),
    );
  }
}

function mediaRecordMatchesFacts(
  document: Readonly<BaseDocument>,
  facts: PortabilityValidatedMediaFacts,
): boolean {
  const record = document as Readonly<Record<string, unknown>>;
  return (
    record.sha256 === facts.sha256 &&
    record.bytes === facts.bytes &&
    record.extension === facts.extension &&
    (facts.namespace === "asset"
      ? record.mime === facts.mime && record.role === facts.role
      : record.sourceMime === facts.mime)
  );
}

export function hashImportTargetRevision(document: unknown): string {
  return hashCanonical(document);
}

export function canonicalImportMediaMetadata(input: {
  facts: PortabilityValidatedMediaFacts;
  document: Readonly<BaseDocument> | null;
}): string {
  return canonicalMediaMetadata(input.facts, input.document);
}

function canonicalMediaMetadata(
  facts: PortabilityValidatedMediaFacts,
  document: Readonly<BaseDocument> | null,
): string {
  const record = (document ?? {}) as Readonly<Record<string, unknown>>;
  const metadata =
    facts.namespace === "asset"
      ? {
          mime: record.mime,
          width: record.width ?? null,
          height: record.height ?? null,
          dpi: record.dpi ?? null,
          role: record.role,
          origin: record.origin,
          exifStripped: record.exifStripped ?? null,
        }
      : { sourceMime: record.sourceMime };
  return hashCanonical({
    namespace: facts.namespace,
    bytes: facts.bytes,
    sha256: facts.sha256,
    mime: facts.mime,
    extension: facts.extension,
    role: facts.role,
    metadata,
  });
}

function namespaceCollection(namespace: string): string | null {
  if (namespace === "asset") return "assets";
  if (namespace === "original") return "original_assets";
  return /^[a-z][a-z0-9_]{0,79}$/.test(namespace) ? namespace : null;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
