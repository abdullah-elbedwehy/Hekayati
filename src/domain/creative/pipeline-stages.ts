import { createHash } from "node:crypto";

import type { JobRecord } from "../../jobs/schemas.js";
import type { NeutralProvenance as Provenance } from "../../contracts/creative-generation.js";
import {
  reviewFindingsSchema,
  sceneListSchema,
  storyPlanSchema,
  storyTextSchema,
} from "../../contracts/creative-outputs.js";
import { canonicalJson } from "../../contracts/canonical-json.js";
import { failCreative } from "./errors.js";
import type { parseStructuredStage } from "./pipeline-support.js";
import type { CreativeRepositories } from "./repositories.js";
import {
  creativeStageRecordSchema,
  type CreativeRun,
  type CreativeStageRecord,
} from "./schemas.js";

export class CreativeStageStore {
  constructor(
    private readonly repositories: CreativeRepositories,
    private readonly now: () => string,
    private readonly idFactory: () => string,
  ) {}

  insert(
    run: CreativeRun,
    job: Readonly<JobRecord>,
    pageNumber: number | null,
    output: ReturnType<typeof parseStructuredStage>,
    provenance: Provenance,
  ): CreativeStageRecord {
    const at = this.now();
    return this.repositories.stages.insert(
      creativeStageRecordSchema.parse({
        id: this.idFactory(),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        runId: run.id,
        projectId: run.projectId,
        jobId: job.id,
        pageNumber,
        output,
        outputHash: createHash("sha256")
          .update(canonicalJson(output))
          .digest("hex"),
        provenance,
      }),
    );
  }

  get(
    runId: string,
    kind: CreativeStageRecord["output"]["kind"],
    pageNumber?: number,
  ): CreativeStageRecord {
    const stage = this.repositories.stages
      .queryByField("runId", runId)
      .find(
        (item) =>
          item.output.kind === kind &&
          (pageNumber === undefined || item.pageNumber === pageNumber),
      );
    if (!stage) failCreative("CREATIVE_DEPENDENCY_INCOMPLETE");
    return stage;
  }

  storyPlan(runId: string) {
    return storyPlanSchema.parse(this.get(runId, "story_plan").output.value);
  }

  storyText(runId: string) {
    return storyTextSchema.parse(this.get(runId, "story_text").output.value);
  }

  sceneList(runId: string) {
    return sceneListSchema.parse(this.get(runId, "scene_list").output.value);
  }

  reviewFindings(runId: string) {
    return reviewFindingsSchema.parse(
      this.get(runId, "review_findings").output.value,
    );
  }
}
