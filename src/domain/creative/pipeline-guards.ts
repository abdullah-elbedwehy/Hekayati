import type { AuthoringRepositories } from "../authoring/repositories.js";
import type { JobScheduler } from "../../jobs/scheduler.js";
import type { JobRecord } from "../../jobs/schemas.js";
import { failCreative } from "./errors.js";
import type { CreativePageService } from "./pages.js";
import type { CreativeRepositories } from "./repositories.js";
import type { CreativeRun, Page } from "./schemas.js";

export function internalReviewCanComplete(
  run: CreativeRun,
  input: { expectedRunRevision: number },
  gateJobId: string,
  pages: Page[],
  hasUnacknowledgedBlock: boolean,
): boolean {
  return (
    run.revision === input.expectedRunRevision &&
    run.internalReviewGateJobId === gateJobId &&
    run.status === "internal_review" &&
    pages.length > 0 &&
    pages.every(
      (page) =>
        page.reviewStatus === "approved" &&
        page.staleState === "current" &&
        Boolean(page.currentIllustrationVersionId),
    ) &&
    !hasUnacknowledgedBlock
  );
}

export function approvalGateJobIds(
  sheets: readonly { id: string }[],
  repositories: CreativeRepositories,
  scheduler: JobScheduler,
): string[] {
  return sheets.map((sheet) => {
    const intent = repositories.sheetIntents
      .queryByField("sheetId", sheet.id)
      .find((item) => item.approvalGateJobId !== null);
    const gate = intent?.approvalGateJobId
      ? scheduler.get(intent.approvalGateJobId)
      : null;
    if (!gate || gate.state !== "succeeded")
      failCreative("CREATIVE_SHEET_NOT_APPROVED");
    return gate.id;
  });
}

export function assertPageSnapshot(
  pages: CreativePageService,
  job: Readonly<JobRecord>,
  pageId: string,
): void {
  const page = pages.getPage(pageId);
  if (
    job.inputSnapshot.pageRevision &&
    job.inputSnapshot.pageRevision !== `r${page.revision}`
  )
    failCreative("CREATIVE_REVISION_CONFLICT");
  if (
    job.inputSnapshot.textVersion &&
    job.inputSnapshot.textVersion !== page.currentTextVersionId
  )
    failCreative("CREATIVE_VERSION_CONFLICT");
  if (
    job.inputSnapshot.promptVersion &&
    job.inputSnapshot.promptVersion !== page.currentPromptVersionId
  )
    failCreative("CREATIVE_VERSION_CONFLICT");
  if (page.locked || page.staleState !== "current")
    failCreative("CREATIVE_PAGE_LOCKED");
}

export function updateCreativeProjectStatus(
  repositories: AuthoringRepositories,
  projectId: string,
  status: "generating" | "internal_review" | "preview_ready",
  at: string,
): void {
  const project = repositories.projects.get(projectId);
  if (!project) failCreative("CREATIVE_ENTITY_NOT_FOUND", 404);
  repositories.projects.update({
    ...project,
    status,
    revision: project.revision + 1,
    updatedAt: at,
  });
}
