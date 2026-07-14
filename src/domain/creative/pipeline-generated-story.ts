import type { ProjectWorkspace } from "../authoring/index.js";
import type { StoryText } from "./output-types.js";
import type { CreativePageService } from "./pages.js";

export function appendGeneratedPageTexts(
  pages: CreativePageService,
  generated: ProjectWorkspace,
  story: StoryText,
): void {
  const storyPages = pages
    .listProjectPages(generated.project.id)
    .filter((page) => page.kind === "story");
  for (const page of storyPages) {
    const storyPage = story.pages.find(
      (item) => item.pageNumber === page.storyPageIndex,
    )!;
    const scene = generated.scenes.find(
      (item) => item.scene.storyPageIndex === page.storyPageIndex,
    )!;
    pages.appendGeneratedText({
      pageId: page.id,
      expectedRevision: page.revision,
      sceneVersionId: scene.version.id,
      narrative: storyPage.narrative,
      dialogue: storyPage.dialogue.map((line) => ({
        speakerCharacterId: line.speaker.characterId,
        text: line.line,
      })),
      inputSnapshot: {
        storyVersion: generated.storyVersion.id,
        sceneVersion: scene.version.id,
      },
    });
  }
}
