import { hashCanonical } from "./hashes.js";

export const COMPOSITION_SOURCE_POLICY_VERSION =
  "hekayati.composition-source.v1" as const;
export const COMPOSITION_TEMPLATE_VERSION =
  "hekayati.composition-templates.v1" as const;

export interface StoryCompositionInput {
  pageId: string;
  pageNumber: number;
  text: string;
  textVersionId: string;
  textHash: string;
  layoutVersionId: string;
  layoutHash: string;
  illustration: {
    assetId: string;
    checksum: string;
    approved: boolean;
  };
}

export interface CustomerCompositionInput {
  projectId: string;
  projectVersionId: string;
  pageCount: 16 | 24;
  title: string;
  dedicationText: string;
  farewellText: string;
  brandLine: string;
  childDisplayName: string;
  environmentLine: string | null;
  synopsis: string | null;
  storyPages: readonly StoryCompositionInput[];
  mainChildThreeQuarter: {
    assetId: string;
    checksum: string;
    approved: boolean;
  } | null;
  identityAsset: { assetId: string; checksum: string };
}

export type InteriorCompositionKind =
  "title" | "dedication" | "story" | "ending1" | "ending2";

export interface InteriorCompositionEntry {
  pageNumber: number;
  kind: InteriorCompositionKind;
  text: string;
  pageId: string | null;
  textVersionId: string | null;
  textHash: string;
  layoutVersionId: string | null;
  layoutHash: string | null;
  artwork: { assetId: string; checksum: string; approved?: boolean } | null;
  selectionSource: "automatic_v1";
  templateVersion: typeof COMPOSITION_TEMPLATE_VERSION;
  inputHash: string;
}

export interface CompiledCustomerComposition {
  interior: InteriorCompositionEntry[];
  cover: {
    front: {
      title: string;
      childDisplayName: string;
      environmentLine: string | null;
      artwork: InteriorCompositionEntry["artwork"];
    };
    back: {
      synopsis: string | null;
      brandLine: string;
      artwork: null;
    };
    hash: string;
  };
  sourcePolicyVersion: typeof COMPOSITION_SOURCE_POLICY_VERSION;
  templateVersion: typeof COMPOSITION_TEMPLATE_VERSION;
  acceptance: "ready" | "needs_operator";
  warnings: string[];
  compositionHash: string;
}

export function compileCustomerComposition(
  input: CustomerCompositionInput,
): CompiledCustomerComposition {
  const expectedStoryPages = input.pageCount === 16 ? 12 : 20;
  if (input.storyPages.length !== expectedStoryPages)
    throw new Error("COMPOSITION_STORY_PAGE_COUNT_INVALID");
  const hero = selectHero(input);
  const interior = compileInterior(input, hero);
  const coverBase = {
    front: {
      title: input.title,
      childDisplayName: input.childDisplayName,
      environmentLine: input.environmentLine,
      artwork: hero,
    },
    back: {
      synopsis: input.synopsis,
      brandLine: input.brandLine,
      artwork: null,
    },
  } as const;
  const warnings = hero ? [] : ["COMPOSITION_SOURCE_REQUIRED"];
  const result = {
    interior,
    cover: { ...coverBase, hash: hashCanonical(coverBase) },
    sourcePolicyVersion: COMPOSITION_SOURCE_POLICY_VERSION,
    templateVersion: COMPOSITION_TEMPLATE_VERSION,
    acceptance: hero ? ("ready" as const) : ("needs_operator" as const),
    warnings,
  };
  return { ...result, compositionHash: hashCanonical(result) };
}

function compileInterior(
  input: CustomerCompositionInput,
  hero: InteriorCompositionEntry["artwork"],
): InteriorCompositionEntry[] {
  const story = input.storyPages.map((page, index) =>
    entry({
      pageNumber: index + 3,
      kind: "story",
      text: page.text,
      pageId: page.pageId,
      textVersionId: page.textVersionId,
      textHash: page.textHash,
      layoutVersionId: page.layoutVersionId,
      layoutHash: page.layoutHash,
      artwork: page.illustration,
    }),
  );
  return [
    entry({ pageNumber: 1, kind: "title", text: input.title, artwork: hero }),
    entry({
      pageNumber: 2,
      kind: "dedication",
      text: input.dedicationText,
      artwork: null,
    }),
    ...story,
    entry({
      pageNumber: input.pageCount - 1,
      kind: "ending1",
      text: input.farewellText,
      artwork: hero,
    }),
    entry({
      pageNumber: input.pageCount,
      kind: "ending2",
      text: `${input.brandLine}\n${input.childDisplayName}`,
      artwork: input.identityAsset,
    }),
  ];
}

function selectHero(
  input: CustomerCompositionInput,
): InteriorCompositionEntry["artwork"] {
  const firstStory = [...input.storyPages]
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .find((page) => page.illustration.approved)?.illustration;
  if (firstStory) return firstStory;
  return input.mainChildThreeQuarter?.approved
    ? input.mainChildThreeQuarter
    : null;
}

function entry(
  value: Omit<
    InteriorCompositionEntry,
    | "selectionSource"
    | "templateVersion"
    | "inputHash"
    | "pageId"
    | "textVersionId"
    | "textHash"
    | "layoutVersionId"
    | "layoutHash"
  > &
    Partial<
      Pick<
        InteriorCompositionEntry,
        | "pageId"
        | "textVersionId"
        | "textHash"
        | "layoutVersionId"
        | "layoutHash"
      >
    >,
): InteriorCompositionEntry {
  const complete = {
    ...value,
    pageId: value.pageId ?? null,
    textVersionId: value.textVersionId ?? null,
    textHash: value.textHash ?? hashCanonical(value.text),
    layoutVersionId: value.layoutVersionId ?? null,
    layoutHash: value.layoutHash ?? null,
    selectionSource: "automatic_v1" as const,
    templateVersion: COMPOSITION_TEMPLATE_VERSION,
  };
  return { ...complete, inputHash: hashCanonical(complete) };
}
