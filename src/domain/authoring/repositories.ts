import type { ZodType } from "zod";

import { canonicalJson } from "../../contracts/canonical-json.js";
import {
  DocumentRepository,
  type BaseDocument,
  type DocumentStore,
} from "../repository/document-store.js";
import { changeEventSchema, type ChangeEvent } from "../library/schemas.js";
import {
  domainMutationAdmission,
  type DomainMutationWriterKey,
  type OperationOwnedMutationContext,
} from "../portability/domain-mutation-admission.js";
import { authoringCollections } from "./collections.js";
import { failAuthoring } from "./errors.js";
import {
  projectOverrideSchema,
  projectOverrideVersionSchema,
  projectSchema,
  projectVersionSchema,
  sceneSchema,
  sceneVersionSchema,
  storySchema,
  storyTemplateSchema,
  storyTemplateVersionSchema,
  storyVersionSchema,
  type Project,
  type ProjectOverride,
  type ProjectOverrideVersion,
  type ProjectVersion,
  type Scene,
  type SceneVersion,
  type Story,
  type StoryTemplate,
  type StoryTemplateVersion,
  type StoryVersion,
} from "./schemas.js";

export { authoringCollections } from "./collections.js";

export class AuthoringRepository<T extends BaseDocument> {
  private readonly documents: DocumentRepository<T>;

  constructor(
    protected readonly store: DocumentStore,
    readonly collection: string,
    protected readonly schema: ZodType<T>,
    private readonly writer: DomainMutationWriterKey = "authoring.document",
  ) {
    this.documents = new DocumentRepository(store, collection, schema);
  }

  get(id: string): T | null {
    return this.documents.get(id);
  }

  list(): T[] {
    return this.documents.list();
  }

  queryByField(field: string, value: string | number | boolean): T[] {
    return this.documents.queryByField(field, value);
  }

  insert(document: T, operation?: OperationOwnedMutationContext): T {
    return this.store.transaction(() => {
      const parsed = this.schema.parse(document);
      if (this.get(parsed.id)) failAuthoring("DUPLICATE_AUTHORING_ID");
      this.store.assertSafeForPersistence(parsed);
      this.assertMutation("insert", null, parsed, operation);
      try {
        this.insertDocument(parsed);
      } catch (error) {
        if (isConstraintFailure(error)) failAuthoring("DUPLICATE_AUTHORING_ID");
        throw error;
      }
      return parsed;
    });
  }

  update(document: T, operation?: OperationOwnedMutationContext): T {
    return this.store.transaction(() => {
      const parsed = this.schema.parse(document);
      const current = this.get(parsed.id);
      if (!current) failAuthoring("DUPLICATE_AUTHORING_ID");
      this.assertMutation("update", current, parsed, operation);
      return this.documents.put(parsed);
    });
  }

  delete(id: string, operation?: OperationOwnedMutationContext): boolean {
    return this.store.transaction(() => {
      const current = this.get(id);
      if (!current) return false;
      this.assertMutation("delete", current, null, operation);
      return this.documents.delete(id);
    });
  }

  private insertDocument(document: T): void {
    this.store.database
      .prepare(
        `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.collection,
        document.id,
        JSON.stringify(document),
        document.schemaVersion,
        document.createdAt,
        document.updatedAt,
      );
  }

  protected assertMutation(
    mutation: "insert" | "update" | "delete",
    before: T | null,
    after: T | null,
    operation?: OperationOwnedMutationContext,
  ): void {
    const admission = domainMutationAdmission(this.store);
    admission.assertInTransaction({
      writer: this.writer,
      collection: this.collection,
      mutation,
      before,
      after,
      operation,
    });
  }
}

export class ProjectRepository extends AuthoringRepository<Project> {
  constructor(
    store: DocumentStore,
    collection: string,
    schema: ZodType<Project>,
  ) {
    super(store, collection, schema, "authoring.project-revision");
  }

  update(
    document: Project,
    operation?: OperationOwnedMutationContext,
  ): Project {
    return this.store.transaction(() => {
      const next = this.schema.parse(document);
      const current = this.get(next.id);
      if (!current) failAuthoring("PROJECT_NOT_FOUND");
      if (next.revision !== current.revision + 1)
        failAuthoring("PROJECT_VERSION_CONFLICT");
      for (const field of projectImmutableFields) {
        if (canonicalJson(current[field]) !== canonicalJson(next[field]))
          failAuthoring("PROJECT_VERSION_CONFLICT");
      }
      this.store.assertSafeForPersistence(next);
      this.assertMutation("update", current, next, operation);
      const result = this.updateProject(current, next);
      if (result.changes !== 1) failAuthoring("PROJECT_VERSION_CONFLICT");
      return next;
    });
  }

  private updateProject(current: Project, next: Project) {
    return this.store.database
      .prepare(
        `UPDATE documents
         SET doc = ?, schema_version = ?, updated_at = ?
         WHERE collection = ? AND id = ?
           AND json_extract(doc, '$.revision') = ?`,
      )
      .run(
        JSON.stringify(next),
        next.schemaVersion,
        next.updatedAt,
        this.collection,
        next.id,
        current.revision,
      );
  }
}

export class AuthoringRepositories {
  readonly projects: ProjectRepository;
  readonly projectVersions: AuthoringRepository<ProjectVersion>;
  readonly projectOverrides: AuthoringRepository<ProjectOverride>;
  readonly projectOverrideVersions: AuthoringRepository<ProjectOverrideVersion>;
  readonly templates: AuthoringRepository<StoryTemplate>;
  readonly templateVersions: AuthoringRepository<StoryTemplateVersion>;
  readonly stories: AuthoringRepository<Story>;
  readonly storyVersions: AuthoringRepository<StoryVersion>;
  readonly scenes: AuthoringRepository<Scene>;
  readonly sceneVersions: AuthoringRepository<SceneVersion>;
  readonly changeEvents: AuthoringRepository<ChangeEvent>;

  constructor(store: DocumentStore) {
    this.projects = new ProjectRepository(
      store,
      authoringCollections.projects,
      projectSchema,
    );
    this.projectVersions = repository(
      store,
      authoringCollections.projectVersions,
      projectVersionSchema,
    );
    this.projectOverrides = repository(
      store,
      authoringCollections.projectOverrides,
      projectOverrideSchema,
    );
    this.projectOverrideVersions = repository(
      store,
      authoringCollections.projectOverrideVersions,
      projectOverrideVersionSchema,
    );
    this.templates = repository(
      store,
      authoringCollections.templates,
      storyTemplateSchema,
    );
    this.templateVersions = repository(
      store,
      authoringCollections.templateVersions,
      storyTemplateVersionSchema,
    );
    this.stories = repository(store, authoringCollections.stories, storySchema);
    this.storyVersions = repository(
      store,
      authoringCollections.storyVersions,
      storyVersionSchema,
    );
    this.scenes = repository(store, authoringCollections.scenes, sceneSchema);
    this.sceneVersions = repository(
      store,
      authoringCollections.sceneVersions,
      sceneVersionSchema,
    );
    this.changeEvents = repository(
      store,
      authoringCollections.changeEvents,
      changeEventSchema,
    );
  }
}

const projectImmutableFields = [
  "id",
  "schemaVersion",
  "createdAt",
  "customerId",
  "familyId",
] as const satisfies readonly (keyof Project)[];

function repository<T extends BaseDocument>(
  store: DocumentStore,
  collection: string,
  schema: ZodType<T>,
): AuthoringRepository<T> {
  return new AuthoringRepository(store, collection, schema);
}

function isConstraintFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}
