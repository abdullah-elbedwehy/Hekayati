import { isDeepStrictEqual } from "node:util";

import type { DocumentStore } from "../repository/document-store.js";
import {
  LibraryDependencyInventoryReader,
  type LibraryDependencyInventory,
} from "./dependency-inventory.js";
import { fail } from "./errors.js";
import {
  characterProfileSchema,
  invalidationReceiptSchema,
  referencePhotoSchema,
  type ChangeEvent,
  type Character,
  type CharacterProfile,
  type CharacterVersion,
  type InvalidationReceipt,
  type Look,
  type LookVersion,
  type ReferencePhoto,
} from "./schemas.js";
import type {
  CreatedCharacter,
  FamilyScope,
  LibraryServiceOptions,
  NewReferencePhoto,
  ProviderPhotoReferenceDraft,
} from "./types.js";
import { VersionedLibrary } from "./versioned-library.js";

/** Public slice-003 facade. Provider bytes and invalidation cascades remain later-owned. */
export class LibraryService extends VersionedLibrary {
  private readonly inventory: LibraryDependencyInventoryReader;

  constructor(store: DocumentStore, options: LibraryServiceOptions = {}) {
    super(store, options);
    this.inventory = new LibraryDependencyInventoryReader(this.repositories);
  }

  resolveProviderPhotoReferenceMetadata(input: ProviderPhotoReferenceDraft): {
    referencePhoto: ReferencePhoto;
    providerAssetId: string;
  } {
    const scope = { customerId: input.customerId, familyId: input.familyId };
    this.assertPhotoConsent(input.customerId, "direct_photo");
    this.scopedCharacter(scope, input.characterId);
    const characterVersion = this.getCharacterVersion(
      scope,
      input.characterId,
      input.owner.characterVersionId,
    );
    const photo = this.repositories.referencePhotos.get(input.referencePhotoId);
    if (!photo) fail("REFERENCE_PHOTO_NOT_FOUND");
    this.assertProviderPhotoLinks(scope, input, characterVersion, photo);
    return { referencePhoto: photo, providerAssetId: photo.providerAssetId! };
  }

  listReferencePhotosForCharacter(
    scope: FamilyScope,
    characterId: string,
  ): ReferencePhoto[] {
    this.scopedCharacter(scope, characterId);
    return this.repositories.referencePhotos
      .queryByField("familyId", scope.familyId)
      .filter(
        (photo) =>
          photo.owner.type === "character" &&
          photo.owner.characterId === characterId,
      );
  }

  listReferencePhotosForLook(
    scope: FamilyScope,
    characterId: string,
    lookId: string,
  ): ReferencePhoto[] {
    this.getLook(scope, characterId, lookId);
    return this.repositories.referencePhotos
      .queryByField("familyId", scope.familyId)
      .filter(
        (photo) =>
          photo.owner.type === "look" &&
          photo.owner.characterId === characterId &&
          photo.owner.lookId === lookId,
      );
  }

  scopeForReferencePhotoId(referencePhotoId: string): FamilyScope {
    this.parseId(referencePhotoId);
    const photo = this.repositories.referencePhotos.get(referencePhotoId);
    if (!photo) fail("REFERENCE_PHOTO_NOT_FOUND");
    const scope = this.scopeForFamilyId(photo.familyId);
    if (photo.customerId !== scope.customerId) fail("FAMILY_SCOPE_MISMATCH");
    return scope;
  }

  getReferencePhoto(
    scope: FamilyScope,
    referencePhotoId: string,
  ): ReferencePhoto {
    this.scopedFamily(scope);
    this.parseId(referencePhotoId);
    const photo = this.repositories.referencePhotos.get(referencePhotoId);
    if (!photo) fail("REFERENCE_PHOTO_NOT_FOUND");
    if (
      photo.customerId !== scope.customerId ||
      photo.familyId !== scope.familyId
    )
      fail("FAMILY_SCOPE_MISMATCH");
    if (photo.owner.type === "look")
      this.getLook(scope, photo.owner.characterId, photo.owner.lookId);
    else this.scopedCharacter(scope, photo.owner.characterId);
    return photo;
  }

  recordInvalidationReceipt(input: {
    eventId: string;
    consequenceHash: string;
    affectedIds: string[];
    consumedAt?: string;
  }): InvalidationReceipt {
    if (!this.repositories.changeEvents.get(input.eventId))
      fail("CHANGE_EVENT_NOT_FOUND");
    const existing = this.repositories.invalidationReceipts.get(input.eventId);
    const receipt = this.buildReceipt(input);
    if (existing) {
      if (
        existing.consequenceHash !== receipt.consequenceHash ||
        !isDeepStrictEqual(existing.affectedIds, receipt.affectedIds)
      )
        fail("INVALIDATION_RECEIPT_CONFLICT");
      return existing;
    }
    return this.repositories.invalidationReceipts.insert(
      receipt,
      "INVALIDATION_RECEIPT_CONFLICT",
    );
  }

  getDependencyInventory(customerId: string): LibraryDependencyInventory {
    this.getCustomer(customerId);
    return this.inventory.forCustomer(customerId);
  }

  attachReferencePhotoToCharacter(
    scope: FamilyScope,
    input: {
      characterId: string;
      expectedVersionId: string;
      versionId?: string;
      correlationId?: string;
      photo: NewReferencePhoto;
    },
  ): {
    character: Character;
    version: CharacterVersion;
    photo: ReferencePhoto;
    events: ChangeEvent[];
  } {
    return this.store.transaction(() => {
      const character = this.assertCharacterMutable(scope, input.characterId);
      const current = this.currentCharacterVersion(character);
      const photo = this.insertReferencePhoto(scope, input.photo, {
        type: "character",
        characterId: character.id,
      });
      const appended = this.appendCharacterVersion(scope, {
        characterId: character.id,
        expectedVersionId: input.expectedVersionId,
        versionId: input.versionId,
        correlationId: input.correlationId,
        profile: profileWithPhoto(current.profile, photo.id),
      });
      return { ...appended, photo };
    });
  }

  attachReferencePhotoToLook(
    scope: FamilyScope,
    input: {
      characterId: string;
      lookId: string;
      expectedVersionId: string;
      versionId?: string;
      correlationId?: string;
      photo: NewReferencePhoto;
    },
  ): {
    look: Look;
    version: LookVersion;
    photo: ReferencePhoto;
    events: ChangeEvent[];
  } {
    return this.store.transaction(() => {
      const look = this.getLook(scope, input.characterId, input.lookId);
      this.assertActive(look.status);
      const current = this.currentLookVersion(look);
      const photo = this.insertReferencePhoto(scope, input.photo, {
        type: "look",
        characterId: input.characterId,
        lookId: input.lookId,
      });
      const appended = this.appendLookVersion(scope, {
        characterId: input.characterId,
        lookId: input.lookId,
        expectedVersionId: input.expectedVersionId,
        versionId: input.versionId,
        correlationId: input.correlationId,
        content: {
          ...current.content,
          referencePhotoIds: uniqueAppend(
            current.content.referencePhotoIds,
            photo.id,
          ),
        },
      });
      return { ...appended, photo };
    });
  }

  createPhotoOnlyCharacter(
    scope: FamilyScope,
    input: {
      characterId?: string;
      versionId?: string;
      sourceMode?: "photo" | "both";
      duplicateDecision?: "create_separate";
      profile: Omit<CharacterProfile, "sourceMode" | "referencePhotoIds">;
      photo: NewReferencePhoto;
    },
  ): CreatedCharacter & { photo: ReferencePhoto; events: ChangeEvent[] } {
    return this.store.transaction(() => {
      const characterId = this.newId(input.characterId);
      const photoId = this.newId(input.photo.id);
      const profile = characterProfileSchema.parse({
        ...input.profile,
        sourceMode: input.sourceMode ?? "photo",
        referencePhotoIds: [photoId],
      });
      const photo = this.insertReferencePhoto(
        scope,
        { ...input.photo, id: photoId },
        { type: "character", characterId },
      );
      const created = this.createCharacter(scope, {
        id: characterId,
        versionId: input.versionId,
        profile,
        duplicateDecision: input.duplicateDecision,
        sourceChecksum: this.repositories.originalAssets.get(
          photo.originalAssetId,
        )?.sha256,
      });
      const events = [
        this.appendInitialPhotoEvent(created.character, created.version),
      ];
      return { ...created, photo, events };
    });
  }

  private buildReceipt(input: {
    eventId: string;
    consequenceHash: string;
    affectedIds: string[];
    consumedAt?: string;
  }): InvalidationReceipt {
    const at = input.consumedAt ?? this.now();
    return invalidationReceiptSchema.parse({
      id: input.eventId,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      eventId: input.eventId,
      consumedAt: at,
      consequenceHash: input.consequenceHash,
      affectedIds: [...new Set(input.affectedIds)].sort(),
    });
  }

  private insertReferencePhoto(
    scope: FamilyScope,
    input: NewReferencePhoto,
    owner: ReferencePhoto["owner"],
  ): ReferencePhoto {
    this.scopedFamily(scope);
    const at = this.now();
    const photo = referencePhotoSchema.parse({
      ...input,
      id: this.newId(input.id),
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      customerId: scope.customerId,
      familyId: scope.familyId,
      owner,
    });
    this.assertReferenceAssetLinks(photo);
    return this.repositories.referencePhotos.insert(
      photo,
      "DUPLICATE_ENTITY_ID",
    );
  }

  private appendInitialPhotoEvent(
    character: Character,
    version: CharacterVersion,
  ): ChangeEvent {
    const at = this.now();
    return this.repositories.changeEvents.insert(
      {
        id: this.newId(),
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        entity: "character",
        entityId: character.id,
        fromVersionId: null,
        toVersionId: version.id,
        changeType: "permanent_appearance",
        matrixRow: "IM-01",
        changedFields: ["sourceMode", "referencePhotoIds"],
        correlationId: this.newId(),
        occurredAt: at,
      },
      "DUPLICATE_ENTITY_ID",
    );
  }

  private assertProviderPhotoLinks(
    scope: FamilyScope,
    input: ProviderPhotoReferenceDraft,
    characterVersion: CharacterVersion,
    photo: ReferencePhoto,
  ): void {
    if (
      photo.customerId !== scope.customerId ||
      photo.familyId !== scope.familyId ||
      photo.owner.characterId !== input.characterId ||
      photo.providerAssetId !== input.providerAssetId ||
      !this.providerAssetIsEligible(input.providerAssetId)
    )
      fail("PROVIDER_REFERENCE_NOT_ELIGIBLE");
    if (input.owner.type === "character") {
      if (
        photo.owner.type !== "character" ||
        !characterVersion.profile.referencePhotoIds.includes(photo.id)
      )
        fail("PROVIDER_REFERENCE_NOT_ELIGIBLE");
      return;
    }
    const lookVersion = this.getLookVersion(
      scope,
      input.characterId,
      input.owner.lookId,
      input.owner.lookVersionId,
    );
    if (
      photo.owner.type !== "look" ||
      photo.owner.lookId !== input.owner.lookId ||
      !lookVersion.content.referencePhotoIds.includes(photo.id)
    )
      fail("PROVIDER_REFERENCE_NOT_ELIGIBLE");
  }

  private providerAssetIsEligible(assetId: string): boolean {
    const row = this.assetMetadata(assetId);
    return (
      row?.role === "reference_photo" &&
      row.origin === "derived" &&
      row.exifStripped &&
      (row.mime === "image/jpeg" || row.mime === "image/png")
    );
  }

  private assertReferenceAssetLinks(photo: ReferencePhoto): void {
    if (!this.repositories.originalAssets.get(photo.originalAssetId))
      fail("REFERENCE_ASSET_NOT_FOUND");
    const working = this.assetMetadata(photo.workingAssetId);
    const thumbnail = this.assetMetadata(photo.thumbnailAssetId);
    if (!working || !thumbnail) fail("REFERENCE_ASSET_NOT_FOUND");
    if (
      working.role !== "reference_photo" ||
      working.origin !== "derived" ||
      !working.exifStripped ||
      (working.mime !== "image/jpeg" && working.mime !== "image/png") ||
      thumbnail.role !== "thumbnail" ||
      thumbnail.origin !== "derived" ||
      !thumbnail.exifStripped ||
      (thumbnail.mime !== "image/jpeg" && thumbnail.mime !== "image/png")
    )
      fail("REFERENCE_ASSET_NOT_ELIGIBLE");
    if (photo.providerAssetId && !this.assetMetadata(photo.providerAssetId))
      fail("REFERENCE_ASSET_NOT_FOUND");
    if (
      photo.providerAssetId &&
      !this.providerAssetIsEligible(photo.providerAssetId)
    )
      fail("REFERENCE_ASSET_NOT_ELIGIBLE");
  }

  private assetMetadata(
    assetId: string,
  ):
    | { role: string; origin: string; exifStripped: boolean; mime: string }
    | undefined {
    const row = this.store.database
      .prepare(
        `SELECT
           json_extract(doc, '$.role') AS role,
           json_extract(doc, '$.origin') AS origin,
           json_extract(doc, '$.exifStripped') AS exif_stripped,
           json_extract(doc, '$.mime') AS mime
         FROM documents WHERE collection = 'assets' AND id = ?`,
      )
      .get(assetId) as
      | { role: string; origin: string; exif_stripped: number; mime: string }
      | undefined;
    return row
      ? {
          role: row.role,
          origin: row.origin,
          exifStripped: row.exif_stripped === 1,
          mime: row.mime,
        }
      : undefined;
  }
}

function profileWithPhoto(
  profile: CharacterProfile,
  photoId: string,
): CharacterProfile {
  return characterProfileSchema.parse({
    ...profile,
    sourceMode:
      profile.sourceMode === "description" ? "both" : profile.sourceMode,
    referencePhotoIds: uniqueAppend(profile.referencePhotoIds, photoId),
  });
}

function uniqueAppend(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id];
}
