import { ulid } from "ulid";

import type { AssetRecord } from "../../assets/asset-store.js";
import type { DocumentStore } from "../repository/document-store.js";
import { AuthoringRepositories } from "../authoring/repositories.js";
import type {
  Project,
  ProjectVersion,
  SceneVersion,
} from "../authoring/schemas.js";
import { CreativeRepositories } from "../creative/repositories.js";
import type {
  IllustrationVersion,
  LayoutWorkRequest,
  Page,
  PageReview,
  PageTextVersion,
} from "../creative/schemas.js";
import { failLayout } from "./errors.js";
import {
  createCompositionInputHash,
  createLayoutHash,
  createPageContentHash,
  hashCanonical,
  type SourceAssetHashInput,
  type TextSourceHashInput,
} from "./hashes.js";
import {
  A4_COMPOSITION_PROFILE_ID,
  resolveLayoutPolicy,
  type LayoutPolicyInput,
} from "./policy.js";
import { LayoutRepositories } from "./repositories.js";
import type {
  CompositionProfile,
  LayoutInputSnapshot,
  LayoutVersion,
  PageLayoutHead,
} from "./schemas.js";
import { COMPOSITION_SOURCE_POLICY_VERSION } from "./composition.js";
import {
  type CompositionSourceAsset,
  resolveCompositionSources,
} from "./sources.js";

export interface LayoutAssetCatalog {
  get(assetId: string): Pick<AssetRecord, "id" | "sha256"> | null;
}

export interface DeriveStoryLayoutInput {
  pageId: string;
  expectedPageRevision: number;
  jobId: string;
  workRequestId?: string | null;
  requestedPlacement: LayoutPolicyInput["requestedPlacement"];
  measurements: LayoutPolicyInput["measurements"];
}

export interface DeriveSpecialLayoutInput {
  pageId: string;
  expectedPageRevision: number;
  jobId: string;
  requestedPlacement: LayoutPolicyInput["requestedPlacement"];
  measurements: LayoutPolicyInput["measurements"];
  selectionSource: "automatic_v1" | "operator";
  selectedAsset?: CompositionSourceAsset | null;
  identityAsset?: CompositionSourceAsset | null;
}

export interface LayoutServiceOptions {
  now?: () => string;
  idFactory?: () => string;
  typographySettingsHash?: string;
  fontManifestHash?: string;
  templateVersion?: string;
  onCommitted?: (input: {
    layout: LayoutVersion;
    head: PageLayoutHead;
    workRequest: LayoutWorkRequest | null;
  }) => void;
}

interface StoryLayoutContext {
  page: Page;
  currentHead: PageLayoutHead | null;
  project: Project;
  projectVersion: ProjectVersion;
  text: PageTextVersion;
  illustration: IllustrationVersion;
  review: PageReview;
  asset: Pick<AssetRecord, "id" | "sha256">;
  scene: SceneVersion;
  profile: CompositionProfile;
  workRequest: LayoutWorkRequest | null;
}

interface StoryLayoutDraft {
  inputSnapshot: LayoutInputSnapshot;
  policy: ReturnType<typeof resolveLayoutPolicy>;
  layoutHash: string;
}

type SpecialPage = Page & { kind: Exclude<Page["kind"], "story"> };

interface SpecialLayoutContext {
  page: SpecialPage;
  currentHead: PageLayoutHead | null;
  project: Project;
  projectVersion: ProjectVersion;
  profile: CompositionProfile;
  text: string;
  sourceAsset: CompositionSourceAsset | null;
}

interface SpecialLayoutDraft {
  inputSnapshot: LayoutInputSnapshot;
  policy: ReturnType<typeof resolveLayoutPolicy>;
  compositionInputHash: string;
}

export class LayoutService {
  private readonly authoring: AuthoringRepositories;
  private readonly creative: CreativeRepositories;
  private readonly layout: LayoutRepositories;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly typographySettingsHash: string;
  private readonly fontManifestHash: string;
  private readonly templateVersion: string;
  private readonly onCommitted: NonNullable<
    LayoutServiceOptions["onCommitted"]
  >;

  constructor(
    private readonly store: DocumentStore,
    private readonly assets: LayoutAssetCatalog,
    options: LayoutServiceOptions = {},
  ) {
    this.authoring = new AuthoringRepositories(store);
    this.creative = new CreativeRepositories(store);
    this.layout = new LayoutRepositories(store);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? ulid;
    this.typographySettingsHash =
      options.typographySettingsHash ?? hashCanonical("typography-v1");
    this.fontManifestHash =
      options.fontManifestHash ?? hashCanonical("bundled-fonts-v1");
    this.templateVersion = options.templateVersion ?? "story-v1";
    this.onCommitted = options.onCommitted ?? (() => undefined);
  }

  deriveStoryLayout(input: DeriveStoryLayoutInput): {
    layout: LayoutVersion;
    head: PageLayoutHead;
  } {
    return this.store.transaction(() => this.deriveStoryInTransaction(input));
  }

  deriveSpecialLayout(input: DeriveSpecialLayoutInput): {
    layout: LayoutVersion;
    head: PageLayoutHead;
  } {
    return this.store.transaction(() => {
      const context = this.loadSpecialContext(input);
      const version = this.commitSpecialLayout(input, context);
      return {
        layout: version,
        head: this.advanceHead(context, version, version.createdAt),
      };
    });
  }

  private deriveStoryInTransaction(input: DeriveStoryLayoutInput) {
    const context = this.loadStoryContext(input);
    const draft = this.buildStoryDraft(input, context);
    return this.commitStoryDraft(input, context, draft);
  }

  private loadSpecialContext(
    input: DeriveSpecialLayoutInput,
  ): SpecialLayoutContext {
    const page = this.creative.pages.get(input.pageId);
    if (!page) failLayout("LAYOUT_PAGE_NOT_FOUND", 404);
    if (!isSpecialPage(page)) failLayout("LAYOUT_PAGE_KIND_INVALID");
    if (
      page.revision !== input.expectedPageRevision ||
      page.staleState !== "current"
    )
      failLayout("LAYOUT_STALE_INPUT");
    const currentHead = this.layout.pageLayoutHeads.get(page.id);
    if (currentHead && page.locked) failLayout("LAYOUT_LOCKED_REPLACEMENT");
    const sources = resolveCompositionSources(
      this.store,
      this.assets,
      page.projectId,
    );
    const profile = this.layout.compositionProfiles.get(
      sources.project.compositionProfileId,
    );
    if (!profile) failLayout("LAYOUT_SOURCE_NOT_FOUND", 404);
    const sourceAsset = this.specialSource(input, page, sources.hero);
    if (
      (page.kind === "title" ||
        page.kind === "ending1" ||
        page.kind === "ending2") &&
      !sourceAsset
    )
      failLayout("LAYOUT_COMPOSITION_SOURCE_REQUIRED");
    return {
      page,
      currentHead,
      project: sources.project,
      projectVersion: sources.projectVersion,
      profile,
      text: specialPageText(
        page.kind,
        sources.projectVersion,
        sources.childDisplayName,
      ),
      sourceAsset,
    };
  }

  private specialSource(
    input: DeriveSpecialLayoutInput,
    page: Page,
    automaticHero: CompositionSourceAsset | null,
  ): CompositionSourceAsset | null {
    const requested =
      input.selectionSource === "operator"
        ? (input.selectedAsset ?? null)
        : page.kind === "ending2"
          ? (input.identityAsset ?? null)
          : page.kind === "dedication"
            ? null
            : automaticHero;
    if (!requested) return null;
    const actual = this.assets.get(requested.assetId);
    if (!actual || actual.sha256 !== requested.checksum)
      failLayout("LAYOUT_SOURCE_NOT_FOUND", 404);
    return requested;
  }

  private commitSpecialLayout(
    input: DeriveSpecialLayoutInput,
    context: SpecialLayoutContext,
  ): LayoutVersion {
    const at = this.now();
    const draft = buildSpecialLayoutDraft(input, context, {
      typographySettingsHash: this.typographySettingsHash,
      fontManifestHash: this.fontManifestHash,
    });
    return this.layout.layoutVersions.insert({
      id: this.idFactory(),
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      pageId: context.page.id,
      previousVersionId: context.currentHead?.currentLayoutVersionId ?? null,
      inputSnapshot: draft.inputSnapshot,
      ...visiblePolicyDecision(draft.policy),
      acceptance: draft.policy.acceptance,
      workRequestId: null,
      jobId: input.jobId,
      layoutHash: createLayoutHash({
        compositionInputHash: draft.compositionInputHash,
        ...visiblePolicyDecision(draft.policy),
      }),
    });
  }

  private loadStoryContext(input: DeriveStoryLayoutInput): StoryLayoutContext {
    const page = this.requireEligiblePage(input);
    const currentHead = this.layout.pageLayoutHeads.get(page.id);
    if (currentHead && page.locked) failLayout("LAYOUT_LOCKED_REPLACEMENT");
    const project = this.authoring.projects.get(page.projectId);
    const projectVersion = project
      ? this.authoring.projectVersions.get(project.currentVersionId)
      : null;
    const text = this.creative.pageTexts.get(page.currentTextVersionId!);
    const illustration = this.creative.illustrations.get(
      page.currentIllustrationVersionId!,
    );
    if (!project || !projectVersion || !text || !illustration)
      failLayout("LAYOUT_SOURCE_NOT_FOUND", 404);
    assertExactCreativeHeads(page, text, illustration);
    const review = this.requireExactReview(page.id, text.id, illustration.id);
    const asset = this.assets.get(illustration.assetId);
    const scene = this.authoring.sceneVersions.get(text.sceneVersionId);
    const profile = this.layout.compositionProfiles.get(
      project.compositionProfileId,
    );
    if (!asset || !scene || !profile)
      failLayout("LAYOUT_SOURCE_NOT_FOUND", 404);
    if (profile.id !== A4_COMPOSITION_PROFILE_ID)
      failLayout("LAYOUT_PROFILE_MISMATCH");
    const workRequest = this.resolveWorkRequest(
      input,
      page.id,
      project.id,
      text.id,
      illustration.id,
    );
    return {
      page,
      currentHead,
      project,
      projectVersion,
      text,
      illustration,
      review,
      asset,
      scene,
      profile,
      workRequest,
    };
  }

  private requireEligiblePage(input: DeriveStoryLayoutInput): Page {
    const page = this.creative.pages.get(input.pageId);
    if (!page) failLayout("LAYOUT_PAGE_NOT_FOUND", 404);
    if (page.kind !== "story") failLayout("LAYOUT_PAGE_KIND_INVALID");
    if (
      page.revision !== input.expectedPageRevision ||
      page.staleState !== "current" ||
      page.reviewStatus !== "approved" ||
      !page.currentTextVersionId ||
      !page.currentIllustrationVersionId
    )
      failLayout("LAYOUT_STALE_INPUT");
    return page;
  }

  private requireExactReview(
    pageId: string,
    textVersionId: string,
    illustrationVersionId: string,
  ): PageReview {
    const review = exactReview(
      this.creative.reviews.queryByField("pageId", pageId),
      textVersionId,
      illustrationVersionId,
    );
    if (!review) failLayout("LAYOUT_REVIEW_REQUIRED");
    return review;
  }

  private buildStoryDraft(
    input: DeriveStoryLayoutInput,
    context: StoryLayoutContext,
  ): StoryLayoutDraft {
    const textSources = layoutTextSources(
      context.page.id,
      context.text,
      context.scene,
    );
    const sourceAssets: SourceAssetHashInput[] = [
      {
        role: "artwork",
        assetId: context.asset.id,
        checksum: context.asset.sha256,
      },
    ];
    const pageContentHash = createPageContentHash({
      textSources,
      sourceAssets,
    });
    const reviewHash = hashReview(context.review);
    const compositionInputHash = this.compositionHash(
      context,
      pageContentHash,
      reviewHash,
      textSources,
      sourceAssets,
    );
    const inputSnapshot = this.storyInputSnapshot(context, {
      pageContentHash,
      reviewHash,
      compositionInputHash,
      textSources,
      sourceAssets,
    });
    const policy = storyPolicy(input, context);
    return {
      inputSnapshot,
      policy,
      layoutHash: createLayoutHash({
        compositionInputHash,
        ...visiblePolicyDecision(policy),
      }),
    };
  }

  private compositionHash(
    context: StoryLayoutContext,
    pageContentHash: string,
    reviewHash: string,
    textSources: TextSourceHashInput[],
    sourceAssets: SourceAssetHashInput[],
  ): string {
    return createCompositionInputHash({
      compositionProfileHash: context.profile.hash,
      projectVersionId: context.projectVersion.id,
      pageContentHash,
      reviewHash,
      compositionSourcePolicyVersion: null,
      selectionSource: "not_applicable",
      templateVersion: this.templateVersion,
      typographySettingsHash: this.typographySettingsHash,
      fontManifestHash: this.fontManifestHash,
      textSources,
      sourceAssets,
    });
  }

  private storyInputSnapshot(
    context: StoryLayoutContext,
    hashes: {
      pageContentHash: string;
      reviewHash: string;
      compositionInputHash: string;
      textSources: TextSourceHashInput[];
      sourceAssets: SourceAssetHashInput[];
    },
  ): LayoutInputSnapshot {
    return {
      compositionProfileId: context.profile.id,
      compositionProfileHash: context.profile.hash,
      projectVersionId: context.projectVersion.id,
      pageObservationRevision: context.page.revision,
      textVersionId: context.text.id,
      illustrationVersionId: context.illustration.id,
      templateVersion: this.templateVersion,
      typographySettingsHash: this.typographySettingsHash,
      fontManifestHash: this.fontManifestHash,
      selectionSource: "not_applicable",
      pageReviewId: context.review.id,
      compositionSourcePolicyVersion: null,
      ...hashes,
    };
  }

  private commitStoryDraft(
    input: DeriveStoryLayoutInput,
    context: StoryLayoutContext,
    draft: StoryLayoutDraft,
  ) {
    const at = this.now();
    const version = this.layout.layoutVersions.insert(
      layoutVersionDocument(input, context, draft, at, this.idFactory()),
    );
    const head = this.advanceHead(context, version, at);
    if (context.workRequest)
      this.creative.layoutWorkRequests.update({
        ...context.workRequest,
        state: "consumed",
        updatedAt: at,
      });
    this.onCommitted({
      layout: version,
      head,
      workRequest: context.workRequest,
    });
    return { layout: version, head };
  }

  private advanceHead(
    context: Pick<StoryLayoutContext, "page" | "currentHead">,
    version: LayoutVersion,
    at: string,
  ): PageLayoutHead {
    return context.currentHead
      ? this.layout.pageLayoutHeads.update(context.currentHead.revision, {
          ...context.currentHead,
          revision: context.currentHead.revision + 1,
          updatedAt: at,
          currentLayoutVersionId: version.id,
        })
      : this.layout.pageLayoutHeads.insert({
          id: context.page.id,
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          revision: 0,
          pageId: context.page.id,
          currentLayoutVersionId: version.id,
        });
  }

  private resolveWorkRequest(
    input: DeriveStoryLayoutInput,
    pageId: string,
    projectId: string,
    textVersionId: string,
    illustrationVersionId: string,
  ): LayoutWorkRequest | null {
    if (!input.workRequestId) return null;
    const request = this.creative.layoutWorkRequests.get(input.workRequestId);
    if (
      !request ||
      request.state !== "pending" ||
      request.pageId !== pageId ||
      request.projectId !== projectId ||
      request.textVersionId !== textVersionId ||
      request.illustrationVersionId !== illustrationVersionId
    )
      failLayout("LAYOUT_WORK_REQUEST_STALE");
    return request;
  }
}

function assertExactCreativeHeads(
  page: Page,
  text: PageTextVersion,
  illustration: IllustrationVersion,
): void {
  if (
    text.pageId !== page.id ||
    illustration.pageId !== page.id ||
    text.id !== page.currentTextVersionId ||
    illustration.id !== page.currentIllustrationVersionId
  )
    failLayout("LAYOUT_STALE_INPUT");
}

function storyPolicy(
  input: DeriveStoryLayoutInput,
  context: StoryLayoutContext,
): ReturnType<typeof resolveLayoutPolicy> {
  return resolveLayoutPolicy({
    requestedPlacement: input.requestedPlacement,
    ageBand: context.projectVersion.storyConfig.audienceAgeBand,
    text: [
      context.text.narrative,
      ...context.text.dialogue.map((item) => item.text),
    ]
      .filter(Boolean)
      .join("\n"),
    measurements: input.measurements,
    dialogue: context.text.dialogue.map((dialogue) => ({
      ...dialogue,
      speakerLabel: speakerLabel(
        dialogue.speakerCharacterId,
        context.projectVersion,
      ),
      position: null,
      positionHints: speakerPositionHints(
        dialogue.speakerCharacterId,
        context.scene,
      ),
    })),
  });
}

function speakerPositionHints(
  characterId: string,
  scene: SceneVersion,
): string[] {
  return scene.content.documentSegments.flatMap((segment) =>
    segment.type === "mention" &&
    segment.characterId === characterId &&
    segment.props.position
      ? [segment.props.position]
      : [],
  );
}

function visiblePolicyDecision(policy: ReturnType<typeof resolveLayoutPolicy>) {
  return {
    requestedPlacement: policy.requestedPlacement,
    resolvedPlacement: policy.resolvedPlacement,
    resolvedRegion: policy.resolvedRegion,
    readabilityAid: policy.readabilityAid,
    fontSizePt: policy.fontSizePt,
    overflow: policy.overflow,
    warnings: policy.warnings,
    bubbles: policy.bubbles,
    measurementHash: policy.measurementHash,
    layoutPolicyVersion: policy.layoutPolicyVersion,
    rendererVersion: policy.rendererVersion,
  };
}

function layoutVersionDocument(
  input: DeriveStoryLayoutInput,
  context: StoryLayoutContext,
  draft: StoryLayoutDraft,
  at: string,
  id: string,
): LayoutVersion {
  return {
    id,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    pageId: context.page.id,
    previousVersionId: context.currentHead?.currentLayoutVersionId ?? null,
    inputSnapshot: draft.inputSnapshot,
    ...visiblePolicyDecision(draft.policy),
    workRequestId: context.workRequest?.id ?? null,
    jobId: input.jobId,
    layoutHash: draft.layoutHash,
    acceptance: draft.policy.acceptance,
  };
}

function exactReview(
  reviews: readonly PageReview[],
  textVersionId: string,
  illustrationVersionId: string,
): PageReview | null {
  return (
    reviews
      .filter(
        (review) =>
          review.completed &&
          review.textVersionId === textVersionId &&
          review.illustrationVersionId === illustrationVersionId,
      )
      .sort((left, right) => {
        const byTime = left.recordedAt.localeCompare(right.recordedAt);
        return byTime || left.id.localeCompare(right.id);
      })
      .at(-1) ?? null
  );
}

function hashReview(review: PageReview): string {
  return hashCanonical({
    id: review.id,
    pageId: review.pageId,
    textVersionId: review.textVersionId,
    illustrationVersionId: review.illustrationVersionId,
    checks: review.checks,
    completed: review.completed,
  });
}

function layoutTextSources(
  pageId: string,
  text: {
    id: string;
    narrative: string;
    dialogue: readonly { speakerCharacterId: string; text: string }[];
  },
  scene: {
    id: string;
    sceneId: string;
    content: unknown;
  },
): TextSourceHashInput[] {
  return [
    {
      role: "story_text",
      entityId: pageId,
      versionId: text.id,
      contentHash: hashCanonical({
        narrative: text.narrative.normalize("NFC"),
        dialogue: text.dialogue,
      }),
    },
    {
      role: "scene_source",
      entityId: scene.sceneId,
      versionId: scene.id,
      contentHash: hashCanonical(scene.content),
    },
  ];
}

function speakerLabel(
  characterId: string,
  projectVersion: {
    storyConfig: {
      participants: readonly { characterId: string; narrativeRole: string }[];
    };
  },
): string {
  return (
    projectVersion.storyConfig.participants.find(
      (participant) => participant.characterId === characterId,
    )?.narrativeRole ?? "المتحدث"
  );
}

function specialPageText(
  kind: Exclude<Page["kind"], "story">,
  projectVersion: ProjectVersion,
  childDisplayName: string,
): string {
  const config = projectVersion.storyConfig;
  if (kind === "title") return config.title;
  if (kind === "dedication") return config.dedicationText;
  if (kind === "ending1") return config.endingPages.farewellText;
  return `${config.endingPages.brandLine}\n${childDisplayName}`;
}

function specialTextRole(kind: Exclude<Page["kind"], "story">): string {
  if (kind === "title") return "title_text";
  if (kind === "dedication") return "dedication_text";
  if (kind === "ending1") return "farewell_text";
  return "brand_text";
}

function buildSpecialLayoutDraft(
  input: DeriveSpecialLayoutInput,
  context: SpecialLayoutContext,
  settings: {
    typographySettingsHash: string;
    fontManifestHash: string;
  },
): SpecialLayoutDraft {
  const refs = specialLayoutRefs(context);
  const pageContentHash = createPageContentHash(refs);
  const templateVersion = `special-${context.page.kind}-v1`;
  const common = {
    compositionProfileHash: context.profile.hash,
    projectVersionId: context.projectVersion.id,
    pageContentHash,
    reviewHash: null,
    compositionSourcePolicyVersion: COMPOSITION_SOURCE_POLICY_VERSION,
    selectionSource: input.selectionSource,
    templateVersion,
    ...settings,
    ...refs,
  };
  const compositionInputHash = createCompositionInputHash(common);
  const policy = resolveLayoutPolicy({
    requestedPlacement: input.requestedPlacement,
    ageBand: context.projectVersion.storyConfig.audienceAgeBand,
    text: context.text,
    measurements: input.measurements,
    dialogue: [],
  });
  return {
    policy,
    compositionInputHash,
    inputSnapshot: specialInputSnapshot(context, common, compositionInputHash),
  };
}

function specialLayoutRefs(context: SpecialLayoutContext): {
  textSources: TextSourceHashInput[];
  sourceAssets: SourceAssetHashInput[];
} {
  return {
    textSources: [
      {
        role: specialTextRole(context.page.kind),
        entityId: context.project.id,
        versionId: context.projectVersion.id,
        contentHash: hashCanonical(context.text.normalize("NFC")),
      },
    ],
    sourceAssets: context.sourceAsset
      ? [
          {
            role:
              context.page.kind === "ending2" ? "brand_identity" : "artwork",
            ...context.sourceAsset,
          },
        ]
      : [],
  };
}

function specialInputSnapshot(
  context: SpecialLayoutContext,
  common: {
    projectVersionId: string;
    pageContentHash: string;
    selectionSource: "automatic_v1" | "operator";
    templateVersion: string;
    typographySettingsHash: string;
    fontManifestHash: string;
    textSources: TextSourceHashInput[];
    sourceAssets: SourceAssetHashInput[];
  },
  compositionInputHash: string,
): LayoutInputSnapshot {
  return {
    compositionProfileId: context.profile.id,
    compositionProfileHash: context.profile.hash,
    pageObservationRevision: context.page.revision,
    textVersionId: null,
    illustrationVersionId: null,
    compositionInputHash,
    pageReviewId: null,
    reviewHash: null,
    compositionSourcePolicyVersion: COMPOSITION_SOURCE_POLICY_VERSION,
    ...common,
  };
}

function isSpecialPage(page: Page): page is SpecialPage {
  return page.kind !== "story";
}
