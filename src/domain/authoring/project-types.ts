import type { ChangeEvent } from "../library/index.js";
import type { BookPage } from "./book-structure.js";
import type { AuthoringCompileResult } from "./mentions.js";
import type {
  Project,
  ProjectOverride,
  ProjectOverrideVersion,
  ProjectVersion,
  Scene,
  SceneVersion,
  Story,
  StoryVersion,
} from "./schemas.js";

export interface SceneRecord {
  scene: Scene;
  version: SceneVersion;
}

export interface ProjectWorkspace {
  project: Project;
  version: ProjectVersion;
  story: Story;
  storyVersion: StoryVersion;
  scenes: SceneRecord[];
  pageMap: BookPage[];
}

export interface ProjectOverrideResult {
  override: ProjectOverride;
  overrideVersion: ProjectOverrideVersion;
  projectVersion: ProjectVersion;
  event: ChangeEvent;
}

export interface SceneCompileResult extends AuthoringCompileResult {
  projectVersionId: string;
  storyVersionId: string;
  sceneVersionId: string;
}

export interface CharacterRemovalPreflight {
  characterId: string;
  affectedSceneIds: string[];
  affectedStoryPageIndexes: number[];
  resolutions: ["cancel", "replace", "remove_mentions"];
}

export type CharacterRemovalResolution =
  | { type: "cancel" }
  | { type: "replace"; replacementCharacterId: string }
  | { type: "remove_mentions" };
