import type { ZodType } from "zod";

import { canonicalJson } from "../../contracts/canonical-json.js";
import {
  DocumentRepository,
  type BaseDocument,
  type DocumentStore,
} from "../repository/document-store.js";
import { changeEventSchema, type ChangeEvent } from "../library/schemas.js";
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

export const authoringCollections = {
  projects: "projects",
  projectVersions: "project_versions",
  projectOverrides: "project_character_overrides",
  projectOverrideVersions: "project_character_override_versions",
  templates: "story_templates",
  templateVersions: "story_template_versions",
  stories: "stories",
  storyVersions: "story_versions",
  scenes: "scenes",
  sceneVersions: "scene_versions",
  changeEvents: "change_events",
} as const;

export class AuthoringRepository<T extends BaseDocument> {
  private readonly documents: DocumentRepository<T>;

  constructor(
    protected readonly store: DocumentStore,
    readonly collection: string,
    protected readonly schema: ZodType<T>,
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

  insert(document: T): T {
    const parsed = this.schema.parse(document);
    if (this.get(parsed.id)) failAuthoring("DUPLICATE_AUTHORING_ID");
    this.store.assertSafeForPersistence(parsed);
    try {
      this.store.database
        .prepare(
          `INSERT INTO documents(collection, id, doc, schema_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.collection,
          parsed.id,
          JSON.stringify(parsed),
          parsed.schemaVersion,
          parsed.createdAt,
          parsed.updatedAt,
        );
    } catch (error) {
      if (isConstraintFailure(error)) failAuthoring("DUPLICATE_AUTHORING_ID");
      throw error;
    }
    return parsed;
  }

  update(document: T): T {
    if (!this.get(document.id)) failAuthoring("DUPLICATE_AUTHORING_ID");
    return this.documents.put(document);
  }
}

export class ProjectRepository extends AuthoringRepository<Project> {
  update(document: Project): Project {
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
    const result = this.store.database
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
    if (result.changes !== 1) failAuthoring("PROJECT_VERSION_CONFLICT");
    return next;
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
