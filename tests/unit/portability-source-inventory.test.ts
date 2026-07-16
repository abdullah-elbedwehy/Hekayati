import { describe, expect, it } from "vitest";

import {
  createPortabilityRegistry,
  type PortabilityCatalogEntry,
} from "../../src/domain/portability/participants.js";
import { realPortabilityParticipants } from "../../src/domain/portability/real-participants.js";
import {
  declaredJobTypes,
  documentMigrationSources,
  documentMutationSources,
  documentRepositorySources,
  loadProductionSources,
  type ProductionSource,
  type SourceFinding,
} from "../helpers/portability-source-inventory.js";

type SourceRoute =
  | {
      readonly kind: "registered-admission";
      readonly writerKeys: readonly string[];
      readonly evidence: readonly string[];
      readonly collections?: readonly string[];
    }
  | {
      readonly kind: "portability-internal";
      readonly writerKey: string;
      readonly collections?: readonly string[];
      readonly evidence?: readonly string[];
    }
  | {
      readonly kind: "cataloged-repository";
      readonly collections: readonly string[];
    }
  | { readonly kind: "storage-primitive" };

const sourceRoutes: Readonly<Record<string, SourceRoute>> = Object.freeze({
  "src/assets/asset-store.ts": {
    kind: "registered-admission",
    writerKeys: ["assets.asset-record"],
    evidence: ["assertMediaReferenceTransaction"],
    collections: ["assets"],
  },
  "src/assets/original-asset-store.ts": {
    kind: "registered-admission",
    writerKeys: ["assets.original-asset-record"],
    evidence: ["assertMediaReferenceTransaction"],
    collections: ["original_assets"],
  },
  "src/domain/authoring/repositories.ts": {
    kind: "registered-admission",
    writerKeys: ["authoring.document", "authoring.project-revision"],
    evidence: ["domainMutationAdmission", "admission.assertInTransaction"],
  },
  "src/domain/creative/repositories.ts": {
    kind: "registered-admission",
    writerKeys: ["creative.document"],
    evidence: ["domainMutationAdmission", "admission.assertInTransaction"],
  },
  "src/domain/layout/migrations.ts": {
    kind: "portability-internal",
    writerKey: "layout.persistence-migration",
    collections: ["composition_profiles"],
  },
  "src/domain/layout/repositories.ts": {
    kind: "registered-admission",
    writerKeys: ["layout.immutable-document", "layout.revisioned-document"],
    evidence: ["domainMutationAdmission", "admission.assertInTransaction"],
  },
  "src/domain/library/repositories.ts": {
    kind: "registered-admission",
    writerKeys: ["library.document"],
    evidence: ["domainMutationAdmission", "admission.assertInTransaction"],
  },
  "src/domain/portability/export-storage-common.ts": {
    kind: "portability-internal",
    writerKey: "portability.export-storage",
  },
  "src/domain/portability/deletion-storage.ts": {
    kind: "portability-internal",
    writerKey: "portability.deletion-storage",
    evidence: [
      "DomainMutationAdmission",
      "operationOwnedMutation",
      "admission.assertInTransaction",
    ],
  },
  "src/domain/portability/repositories.ts": {
    kind: "portability-internal",
    writerKey: "portability.operation-repositories",
  },
  "src/domain/print/repositories.ts": {
    kind: "registered-admission",
    writerKeys: ["print.immutable-document", "print.revisioned-document"],
    evidence: ["domainMutationAdmission", "admission.assertInTransaction"],
  },
  "src/domain/repository/document-store.ts": {
    kind: "storage-primitive",
  },
  "src/domain/settings/settings.ts": {
    kind: "cataloged-repository",
    collections: ["settings"],
  },
  "src/domain/system/sentinel.ts": {
    kind: "cataloged-repository",
    collections: ["system_state"],
  },
  "src/jobs/history.ts": {
    kind: "cataloged-repository",
    collections: [
      "credential_incidents",
      "credential_remediation_audits",
      "job_audit_events",
      "job_events",
      "provider_target_change_audits",
      "quota_incidents",
      "scheduler_controls",
    ],
  },
  "src/jobs/repository.ts": {
    kind: "registered-admission",
    writerKeys: ["jobs.job-record"],
    evidence: ["JobScopeAdmission"],
  },
});

describe("portability source inventory", () => {
  it("fails closed for every production documents-table writer", async () => {
    const sources = await loadProductionSources(process.cwd());
    const registry = createPortabilityRegistry(realPortabilityParticipants);
    const mutations = documentMutationSources(sources);
    const repositories = documentRepositorySources(sources);
    const migrations = documentMigrationSources(sources);
    const activePaths = new Set(
      [...mutations, ...repositories, ...migrations].map((item) => item.path),
    );
    const firstFinding = new Map(
      [...mutations, ...repositories, ...migrations].map((item) => [
        item.path,
        item,
      ]),
    );

    failFindings(
      "PORTABILITY_DOCUMENT_WRITER_SOURCE_UNREGISTERED",
      [...activePaths]
        .filter((path) => !sourceRoutes[path])
        .map((path) => firstFinding.get(path) ?? { path, line: 0 }),
    );
    failFindings(
      "PORTABILITY_DOCUMENT_WRITER_SOURCE_STALE",
      Object.keys(sourceRoutes)
        .filter((path) => !activePaths.has(path))
        .map((path) => ({ path, line: 1 })),
    );

    assertRoutes(sources, registry.catalog.scopedWriters);
    assertRepositoryCollections(repositories, registry.catalog.collections);
    expect(sourceRoutes["src/domain/layout/migrations.ts"]).toEqual({
      kind: "portability-internal",
      writerKey: "layout.persistence-migration",
      collections: ["composition_profiles"],
    });
  });

  it("keeps every production job-type declaration inside the catalog", async () => {
    const sources = await loadProductionSources(process.cwd());
    const registry = createPortabilityRegistry(realPortabilityParticipants);
    const production = sources.filter(
      (source) => !source.path.startsWith("src/domain/portability/"),
    );
    const findings = declaredJobTypes(production);
    const catalog = new Set(
      registry.catalog.jobTypes
        .filter((entry) => entry.owner === "participant")
        .map((entry) => entry.key),
    );

    failJobTypes(
      "PORTABILITY_JOB_TYPE_UNREGISTERED",
      findings.filter((finding) => !catalog.has(finding.jobType)),
    );
    const declared = new Set(findings.map((finding) => finding.jobType));
    const missing = [...catalog].filter((jobType) => !declared.has(jobType));
    if (missing.length > 0)
      throw new Error(
        `PORTABILITY_JOB_TYPE_NOT_DECLARED:\n${missing.sort().join("\n")}`,
      );
  });
});

function assertRoutes(
  sources: readonly ProductionSource[],
  scopedWriters: readonly PortabilityCatalogEntry[],
): void {
  const sourceByPath = new Map(sources.map((source) => [source.path, source]));
  const registered = new Map(scopedWriters.map((entry) => [entry.key, entry]));
  for (const [path, route] of Object.entries(sourceRoutes)) {
    if (route.kind === "registered-admission") {
      for (const writerKey of route.writerKeys) {
        const entry = registered.get(writerKey);
        if (entry?.owner !== "participant")
          throw new Error(
            `PORTABILITY_DOCUMENT_WRITER_KEY_UNREGISTERED:${path}:${writerKey}`,
          );
      }
      const text = sourceByPath.get(path)?.text ?? "";
      for (const evidence of route.evidence)
        if (!text.includes(evidence))
          throw new Error(
            `PORTABILITY_DOCUMENT_WRITER_ADMISSION_MISSING:${path}:${evidence}`,
          );
      continue;
    }
    if (
      route.kind === "portability-internal" &&
      !route.writerKey.startsWith("portability.") &&
      registered.get(route.writerKey)?.owner !== "internal"
    )
      throw new Error(
        `PORTABILITY_INTERNAL_WRITER_UNREGISTERED:${path}:${route.writerKey}`,
      );
    if (route.kind === "portability-internal" && route.evidence) {
      const text = sourceByPath.get(path)?.text ?? "";
      for (const evidence of route.evidence)
        if (!text.includes(evidence))
          throw new Error(
            `PORTABILITY_DOCUMENT_WRITER_ADMISSION_MISSING:${path}:${evidence}`,
          );
    }
  }
}

function assertRepositoryCollections(
  repositories: ReturnType<typeof documentRepositorySources>,
  collections: readonly PortabilityCatalogEntry[],
): void {
  const registered = new Set(collections.map((entry) => entry.key));
  for (const repository of repositories) {
    const route = sourceRoutes[repository.path];
    if (!route)
      throw new Error(
        `PORTABILITY_DOCUMENT_REPOSITORY_UNREGISTERED:${format(repository)}`,
      );
    if (!repository.collection) continue;
    if (
      !("collections" in route) ||
      !route.collections?.includes(repository.collection)
    )
      throw new Error(
        `PORTABILITY_DOCUMENT_REPOSITORY_COLLECTION_UNROUTED:${format(repository)}:${repository.collection}`,
      );
    if (!registered.has(repository.collection))
      throw new Error(
        `PORTABILITY_DOCUMENT_REPOSITORY_COLLECTION_UNREGISTERED:${format(repository)}:${repository.collection}`,
      );
  }
}

function failFindings(code: string, findings: readonly SourceFinding[]): void {
  if (findings.length === 0) return;
  throw new Error(`${code}:\n${findings.map(format).sort().join("\n")}`);
}

function failJobTypes(
  code: string,
  findings: readonly (SourceFinding & { jobType: string })[],
): void {
  if (findings.length === 0) return;
  throw new Error(
    `${code}:\n${findings
      .map((finding) => `${format(finding)}:${finding.jobType}`)
      .sort()
      .join("\n")}`,
  );
}

function format(finding: SourceFinding): string {
  return `${finding.path}:${finding.line}`;
}
