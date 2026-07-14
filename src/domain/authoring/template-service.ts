import { ulid } from "ulid";

import type { DocumentStore } from "../repository/document-store.js";
import { failAuthoring } from "./errors.js";
import { AuthoringRepositories } from "./repositories.js";
import { seedTemplateDefinitions } from "./seed-templates.js";
import {
  storyTemplateContentSchema,
  type StoryTemplate,
  type StoryTemplateContent,
  type StoryTemplateVersion,
  type TemplateStatus,
} from "./schemas.js";

export interface TemplateRecord {
  id: string;
  status: TemplateStatus;
  template: StoryTemplate;
  version: StoryTemplateVersion;
}

export interface TemplateServiceOptions {
  now?: () => string;
  idFactory?: () => string;
}

export class TemplateService {
  private readonly repositories: AuthoringRepositories;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: DocumentStore,
    options: TemplateServiceOptions = {},
  ) {
    this.repositories = new AuthoringRepositories(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
  }

  list(options: { includeHidden?: boolean } = {}): TemplateRecord[] {
    return this.repositories.templates
      .list()
      .filter(
        (template) => options.includeHidden || template.status === "active",
      )
      .map((template) => this.record(template));
  }

  get(templateId: string): TemplateRecord {
    const template = this.repositories.templates.get(templateId);
    if (!template) failAuthoring("TEMPLATE_NOT_FOUND");
    return this.record(template);
  }

  getVersion(templateId: string, versionId: string): TemplateRecord {
    const template = this.repositories.templates.get(templateId);
    if (!template) failAuthoring("TEMPLATE_NOT_FOUND");
    const version = this.repositories.templateVersions.get(versionId);
    if (!version || version.templateId !== template.id)
      failAuthoring("TEMPLATE_VERSION_NOT_FOUND");
    return templateRecord(template, version);
  }

  resolveSelectable(input: {
    templateId?: string | null;
    seedKey?: string | null;
  }): TemplateRecord {
    const template = input.templateId
      ? this.repositories.templates.get(input.templateId)
      : this.repositories.templates
          .list()
          .find((candidate) => candidate.seedKey === input.seedKey);
    if (!template) failAuthoring("TEMPLATE_REQUIRED");
    if (template.status !== "active") failAuthoring("TEMPLATE_NOT_SELECTABLE");
    return this.record(template);
  }

  create(content: StoryTemplateContent): TemplateRecord {
    const parsed = storyTemplateContentSchema.parse(content);
    return this.store.transaction(() => this.insertTemplate(null, parsed));
  }

  appendVersion(
    templateId: string,
    input: { expectedVersionId: string; content: StoryTemplateContent },
  ): TemplateRecord {
    const content = storyTemplateContentSchema.parse(input.content);
    return this.store.transaction(() => {
      const template = this.repositories.templates.get(templateId);
      if (!template) failAuthoring("TEMPLATE_NOT_FOUND");
      if (template.currentVersionId !== input.expectedVersionId)
        failAuthoring("TEMPLATE_VERSION_CONFLICT");
      const at = this.now();
      const version = this.insertVersion(
        template.id,
        template.currentVersionId,
        content,
        at,
      );
      const updated = this.repositories.templates.update({
        ...template,
        currentVersionId: version.id,
        updatedAt: at,
      });
      return templateRecord(updated, version);
    });
  }

  duplicate(templateId: string): TemplateRecord {
    const source = this.get(templateId);
    return this.create({
      ...source.version.content,
      name: `${source.version.content.name} — نسخة`,
    });
  }

  setStatus(
    templateId: string,
    input: {
      expectedVersionId: string;
      expectedStatus: TemplateStatus;
      status: TemplateStatus;
    },
  ): TemplateRecord {
    return this.store.transaction(() => {
      const template = this.repositories.templates.get(templateId);
      if (!template) failAuthoring("TEMPLATE_NOT_FOUND");
      if (
        template.currentVersionId !== input.expectedVersionId ||
        template.status !== input.expectedStatus
      )
        failAuthoring("TEMPLATE_VERSION_CONFLICT");
      const updated = this.repositories.templates.update({
        ...template,
        status: input.status,
        updatedAt: this.now(),
      });
      return this.record(updated);
    });
  }

  private record(template: StoryTemplate): TemplateRecord {
    const version = this.repositories.templateVersions.get(
      template.currentVersionId,
    );
    if (!version || version.templateId !== template.id)
      failAuthoring("TEMPLATE_VERSION_NOT_FOUND");
    return templateRecord(template, version);
  }

  private insertTemplate(
    seedKey: string | null,
    content: StoryTemplateContent,
  ): TemplateRecord {
    const at = this.now();
    const templateId = this.idFactory();
    const version = this.insertVersion(templateId, null, content, at);
    const template = this.repositories.templates.insert({
      id: templateId,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      seedKey,
      status: "active",
      currentVersionId: version.id,
    });
    return templateRecord(template, version);
  }

  private insertVersion(
    templateId: string,
    previousVersionId: string | null,
    content: StoryTemplateContent,
    at: string,
  ): StoryTemplateVersion {
    return this.repositories.templateVersions.insert({
      id: this.idFactory(),
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      templateId,
      previousVersionId,
      content,
    });
  }
}

function templateRecord(
  template: StoryTemplate,
  version: StoryTemplateVersion,
): TemplateRecord {
  return { id: template.id, status: template.status, template, version };
}

export function installSeedTemplates(
  store: DocumentStore,
  options: TemplateServiceOptions = {},
): void {
  const service = new TemplateService(store, options);
  store.transaction(() => {
    const installedKeys = new Set(
      service
        .list({ includeHidden: true })
        .map(({ template }) => template.seedKey)
        .filter((key): key is string => key !== null),
    );
    for (const seed of seedTemplateDefinitions) {
      if (installedKeys.has(seed.seedKey)) continue;
      insertSeed(store, seed.seedKey, seed.content, options);
    }
  });
}

function insertSeed(
  store: DocumentStore,
  seedKey: string,
  content: StoryTemplateContent,
  options: TemplateServiceOptions,
): void {
  const repositories = new AuthoringRepositories(store);
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? ulid;
  const at = now();
  const templateId = idFactory();
  const version = repositories.templateVersions.insert({
    id: idFactory(),
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    templateId,
    previousVersionId: null,
    content: storyTemplateContentSchema.parse(content),
  });
  repositories.templates.insert({
    id: templateId,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    seedKey,
    status: "active",
    currentVersionId: version.id,
  });
}
