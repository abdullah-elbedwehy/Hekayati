import { createHash } from "node:crypto";

import type { JobRecord } from "../../jobs/schemas.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import type { PreviewOutput } from "../layout/schemas.js";
import type { ChangeEvent } from "../library/schemas.js";
import type {
  InvalidationArtifact,
  InvalidationConsequence,
} from "./invalidation-rules.js";

export interface CreativeInvalidationOptions {
  now?: () => string;
  idFactory?: () => string;
}

export type AppendChangeEventInput = Omit<
  ChangeEvent,
  "schemaVersion" | "createdAt" | "updatedAt" | "occurredAt"
> & { occurredAt?: string };

export interface InvalidationGateController {
  get(id: string): JobRecord | null;
  cancelOwnedHumanGate(
    id: string,
    input: {
      expectedRevision: number;
      targetVersionId: string;
      reason: string;
    },
    ownerVerify: (job: JobRecord) => boolean,
  ): JobRecord;
}

export interface ResolvedArtifact extends InvalidationArtifact {
  projectId: string | null;
  record: unknown;
}

export interface InvalidationParticipant {
  resolve(event: ChangeEvent): ResolvedArtifact[];
  sourceProjectIds(event: ChangeEvent): string[];
  apply(
    event: ChangeEvent,
    artifacts: readonly ResolvedArtifact[],
    consequences: readonly InvalidationConsequence[],
  ): void;
}

export function hashConsequences(
  event: ChangeEvent,
  consequences: readonly InvalidationConsequence[],
  projectIds: readonly string[],
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        eventId: event.id,
        row: event.matrixRow,
        consequences: [...consequences].sort((left, right) =>
          `${left.kind}:${left.artifactId}`.localeCompare(
            `${right.kind}:${right.artifactId}`,
          ),
        ),
        projectIds: [...projectIds].sort(),
      }),
    )
    .digest("hex");
}

export function previewReferencesAsset(
  output: PreviewOutput,
  assetId: string,
): boolean {
  return output.orderedInteriorPages.some((page) =>
    page.sourceAssets.some((source) => source.assetId === assetId),
  );
}

export function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}
