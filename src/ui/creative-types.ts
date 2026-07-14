export interface CreativePolicyConfirmations {
  prompt?: {
    policyVersion: "prompt-policy-v1";
    bindingHash: string;
    confirmed: true;
  };
  capacity?: { bindingHash: string; confirmed: true };
}

export type CreativePolicyChallengeCode =
  | "CREATIVE_POLICY_CONFIRMATION_REQUIRED"
  | "CREATIVE_POLICY_CONFIRMATION_STALE"
  | "CREATIVE_CAPACITY_CONFIRMATION_REQUIRED"
  | "CREATIVE_CAPACITY_CONFIRMATION_STALE";

export interface CreativeSheetIntent {
  id: string;
  sheetId: string;
  projectId: string;
  characterId: string;
  characterVersionId: string;
  characterName: string;
  revision: number;
  status: "planned" | "generating" | "finalizing" | "ready" | "rejected";
  approvalGateJobId: string | null;
  priorSheetId: string | null;
}

export interface CreativeSheet {
  id: string;
  projectId: string;
  characterId: string;
  characterVersionId: string;
  characterName: string;
  revision: number;
  status: "ready" | "revision_needed" | "approved" | "approved_superseded";
  pdfAssetId: string;
  views: Record<
    "face" | "front" | "threeQuarter" | "fullBody" | "mainOutfit",
    string
  >;
  priorSheetId: string | null;
}

export interface CreativeRunNode {
  key: string;
  kind: string;
  pageNumber: number | null;
  jobId: string | null;
  state: "planned" | "materialized" | "committed" | "failed";
}

export interface CreativeRun {
  id: string;
  projectId: string;
  projectVersionId: string;
  inputStoryVersionId: string;
  outputStoryVersionId: string | null;
  revision: number;
  status:
    | "planned"
    | "generating"
    | "internal_review"
    | "complete"
    | "failed"
    | "stale";
  nodes: CreativeRunNode[];
  internalReviewGateJobId: string | null;
}

export interface CreativePage {
  id: string;
  projectId: string;
  pageNumber: number;
  storyPageIndex: number | null;
  kind: "title" | "dedication" | "story" | "ending1" | "ending2";
  revision: number;
  locked: boolean;
  reviewStatus: "unreviewed" | "flagged" | "approved";
  staleState: "current" | "stale" | "locked_stale";
  staleReasons: string[];
  currentTextVersionId: string | null;
  currentPromptVersionId: string | null;
  currentIllustrationVersionId: string | null;
  currentLayoutVersionId: string | null;
}

export interface CreativeSnapshot {
  sheets: CreativeSheet[];
  sheetIntents: CreativeSheetIntent[];
  runs: CreativeRun[];
  pages: CreativePage[];
  layoutRequests: Array<{
    id: string;
    pageId: string;
    state: "pending" | "consumed" | "canceled";
  }>;
}

export interface CreativePageHistory {
  text: Array<{
    id: string;
    narrative: string;
    dialogue: Array<{ speakerCharacterId: string; text: string }>;
    source: "generated" | "manual" | "revert";
    createdAt: string;
  }>;
  illustrations: Array<{
    id: string;
    assetId: string;
    promptVersionId: string;
    createdAt: string;
  }>;
}

export interface CreativeFinding {
  key: string;
  scope: "story" | "page" | "character";
  refId: string;
  pageNumber?: number;
  category: string;
  severity: "info" | "warn" | "block";
  excerpt: string;
  note: string;
  acknowledged: boolean;
}

export type CreativeReviewCheckKey =
  | "identityMatchesSheet"
  | "outfitMatchesPlan"
  | "participantsExact"
  | "petAnatomySafe"
  | "ageAndRegisterAppropriate"
  | "noInImageText"
  | "artTextConsistent"
  | "noSexualizedChild"
  | "noGraphicViolence"
  | "noDangerousInstructions"
  | "noHumiliationOrPunishment"
  | "noHateOrStereotypes"
  | "noAdultThemes"
  | "noChildBlame"
  | "noExcessiveFear"
  | "noCopyrightCharacter"
  | "noLivingArtistImitation"
  | "noContactDetails"
  | "noCrossCustomerData";

export type CreativeReviewChecks = Record<CreativeReviewCheckKey, boolean>;
