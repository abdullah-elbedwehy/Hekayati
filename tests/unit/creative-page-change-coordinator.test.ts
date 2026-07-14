import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";

import { resolveDataPaths } from "../../src/config/paths.js";
import { AuthoringService } from "../../src/domain/authoring/index.js";
import { AuthoringRepositories } from "../../src/domain/authoring/repositories.js";
import { PageChangeCoordinator } from "../../src/domain/creative/page-change-coordinator.js";
import type {
  Page,
  PageTextVersion,
} from "../../src/domain/creative/schemas.js";
import { LibraryService } from "../../src/domain/library/index.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";
import { seedCreativeProject } from "../helpers/creative-fixtures.js";
import { temporaryDirectory } from "../helpers/temp.js";

const at = "2026-07-14T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("page change authoring linkage guards", () => {
  it("rejects non-story pages and stale scene-version links", async () => {
    const temp = await temporaryDirectory("hekayati-page-change-guard-");
    cleanups.push(temp.cleanup);
    const seed = await seedCreativeProject(temp.path, "-guard");
    const store = new DocumentStore(resolveDataPaths(temp.path).database);
    const project = new AuthoringRepositories(store).projects.get(
      seed.projectId,
    )!;
    const workspace = new AuthoringService(
      store,
      new LibraryService(store),
    ).getProjectWorkspace(seed.scope, seed.projectId);
    const coordinator = new PageChangeCoordinator(store, { now: () => at });
    const current = textVersion(ulid());

    expect(() =>
      coordinator.appendAuthoringNarrative(
        page(seed.projectId, null, "title"),
        current,
        project,
        { narrative: "نص اصطناعي", dialogue: [] },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );

    const storyPageIndex = workspace.scenes[0].scene.storyPageIndex;
    expect(() =>
      coordinator.appendAuthoringNarrative(
        page(seed.projectId, storyPageIndex, "story"),
        current,
        project,
        { narrative: "نص اصطناعي", dialogue: [] },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "CREATIVE_VERSION_CONFLICT" }),
    );
    store.close();
  });
});

function page(
  projectId: string,
  storyPageIndex: number | null,
  kind: "title" | "story",
): Page {
  return {
    id: ulid(),
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    revision: 0,
    projectId,
    pageNumber: storyPageIndex === null ? 1 : storyPageIndex + 2,
    storyPageIndex,
    kind,
    locked: false,
    reviewStatus: "unreviewed",
    staleState: "current",
    staleReasons: [],
    currentTextVersionId: null,
    currentPromptVersionId: null,
    currentIllustrationVersionId: null,
    currentLayoutVersionId: null,
  };
}

function textVersion(sceneVersionId: string): PageTextVersion {
  return {
    id: ulid(),
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    pageId: ulid(),
    previousVersionId: null,
    sceneVersionId,
    narrative: "قديم",
    dialogue: [],
    source: "generated",
    inputSnapshot: {},
  };
}
