import type { Character, CharacterVersion, ReferencePhoto } from "./schemas.js";

export interface FamilyScope {
  customerId: string;
  familyId: string;
}

export type PhotoConsentUse =
  | "direct_photo"
  | "photo_derived_sheet"
  | "description_only"
  | "description_derived_sheet";

export type ConsentDecision =
  | { allowed: true; reason: "CONSENT_GRANTED" | "PHOTO_NOT_REQUIRED" }
  | {
      allowed: false;
      code: "PHOTO_CONSENT_NOT_RECORDED" | "PHOTO_CONSENT_NOT_GRANTED";
    };

export interface DuplicateCandidate {
  characterId: string;
  currentVersionId: string;
  matches: Array<"normalized_name_relationship" | "source_checksum">;
}

export interface LibraryServiceOptions {
  now?: () => string;
  idFactory?: () => string;
}

export type NewReferencePhoto = Omit<
  ReferencePhoto,
  | "schemaVersion"
  | "createdAt"
  | "updatedAt"
  | "customerId"
  | "familyId"
  | "owner"
>;

export type ProviderPhotoReferenceDraft = {
  source: "reference_photo";
  referencePhotoId: string;
  customerId: string;
  familyId: string;
  characterId: string;
  owner:
    | { type: "character"; characterVersionId: string }
    | {
        type: "look";
        lookId: string;
        characterVersionId: string;
        lookVersionId: string;
      };
  providerAssetId: string;
};

export interface CreatedCharacter {
  character: Character;
  version: CharacterVersion;
  duplicateCandidates: DuplicateCandidate[];
}
