import {
  classifyCharacterChange,
  classifyLookChange,
  type ClassifiedChange,
} from "./classification.js";
import { fail } from "./errors.js";
import { LibraryCore } from "./library-core.js";
import {
  normalizeDuplicateDisplayName,
  relationshipKey,
} from "./normalization.js";
import {
  characterProfileSchema,
  lookContentSchema,
  sha256Pattern,
  type ChangeEvent,
  type Character,
  type CharacterProfile,
  type CharacterVersion,
  type Family,
  type Look,
  type LookContent,
  type LookVersion,
  type Relationship,
} from "./schemas.js";
import type {
  CreatedCharacter,
  DuplicateCandidate,
  FamilyScope,
} from "./types.js";

export class VersionedLibrary extends LibraryCore {
  createCharacter(
    scope: FamilyScope,
    input: {
      id?: string;
      versionId?: string;
      profile: CharacterProfile;
      duplicateDecision?: "create_separate";
      sourceChecksum?: string;
    },
  ): CreatedCharacter {
    const profile = characterProfileSchema.parse(input.profile);
    const characterId = this.newId(input.id);
    const versionId = this.newId(input.versionId);
    const duplicateCandidates = this.findDuplicateCharacters(scope, {
      name: profile.name,
      relationship: profile.relationship,
      sourceChecksum: input.sourceChecksum,
    });
    if (
      duplicateCandidates.length > 0 &&
      input.duplicateDecision !== "create_separate"
    )
      fail("DUPLICATE_DECISION_REQUIRED");
    return this.store.transaction(() => {
      const { customer, family } = this.scopedFamily(scope);
      this.assertActive(customer.status, family.status);
      this.assertNewMemberAnchor(family, profile.relationship);
      this.assertCharacterReferenceOwnership(scope, characterId, profile);
      return {
        ...this.insertInitialCharacter(family, characterId, versionId, profile),
        duplicateCandidates,
      };
    });
  }

  getCharacter(scope: FamilyScope, characterId: string): Character {
    this.scopedFamily(scope);
    return this.scopedCharacter(scope, characterId);
  }

  scopeForCharacterId(characterId: string): FamilyScope {
    this.parseId(characterId);
    const character =
      this.repositories.characters.get(characterId) ??
      fail("CHARACTER_NOT_FOUND");
    return this.scopeForFamilyId(character.familyId);
  }

  getCharacterVersion(
    scope: FamilyScope,
    characterId: string,
    versionId: string,
  ): CharacterVersion {
    this.scopedCharacter(scope, characterId);
    const version = this.repositories.characterVersions.get(versionId);
    if (!version) fail("CHARACTER_VERSION_NOT_FOUND");
    if (version.characterId !== characterId) fail("FAMILY_SCOPE_MISMATCH");
    return version;
  }

  listCharacterVersions(
    scope: FamilyScope,
    characterId: string,
  ): CharacterVersion[] {
    this.scopedCharacter(scope, characterId);
    return lineageOrder(
      this.repositories.characterVersions.queryByField(
        "characterId",
        characterId,
      ),
    );
  }

  listCharacters(
    scope: FamilyScope,
    options: { includeArchived?: boolean } = {},
  ): Character[] {
    const { customer, family } = this.scopedFamily(scope);
    const characters = this.repositories.characters.queryByField(
      "familyId",
      scope.familyId,
    );
    if (options.includeArchived) return characters;
    if (!this.familyIsSelectable(customer, family)) return [];
    return characters.filter((character) => character.status === "active");
  }

  appendCharacterVersion(
    scope: FamilyScope,
    input: {
      characterId: string;
      expectedVersionId: string;
      versionId?: string;
      profile: CharacterProfile;
      correlationId?: string;
    },
  ): {
    character: Character;
    version: CharacterVersion;
    events: ChangeEvent[];
  } {
    const profile = characterProfileSchema.parse(input.profile);
    const versionId = this.newId(input.versionId);
    const correlationId = this.newId(input.correlationId);
    return this.store.transaction(() =>
      this.appendCharacterInTransaction(scope, {
        ...input,
        versionId,
        correlationId,
        profile,
      }),
    );
  }

  revertCharacterVersion(
    scope: FamilyScope,
    input: {
      characterId: string;
      expectedVersionId: string;
      targetVersionId: string;
      versionId?: string;
      correlationId?: string;
    },
  ): {
    character: Character;
    version: CharacterVersion;
    events: ChangeEvent[];
  } {
    const target = this.getCharacterVersion(
      scope,
      input.characterId,
      input.targetVersionId,
    );
    return this.appendCharacterVersion(scope, {
      characterId: input.characterId,
      expectedVersionId: input.expectedVersionId,
      versionId: input.versionId,
      correlationId: input.correlationId,
      profile: target.profile,
    });
  }

  archiveCharacter(
    scope: FamilyScope,
    characterId: string,
  ): { character: Character; events: ChangeEvent[] } {
    return this.setCharacterStatus(scope, characterId, "archived");
  }

  restoreCharacter(
    scope: FamilyScope,
    characterId: string,
  ): { character: Character; events: ChangeEvent[] } {
    return this.setCharacterStatus(scope, characterId, "active");
  }

  createLook(
    scope: FamilyScope,
    input: {
      id?: string;
      versionId?: string;
      characterId: string;
      content: LookContent;
    },
  ): { look: Look; version: LookVersion } {
    const content = lookContentSchema.parse(input.content);
    return this.store.transaction(() => {
      this.assertCharacterMutable(scope, input.characterId);
      const at = this.now();
      const lookId = this.newId(input.id);
      const versionId = this.newId(input.versionId);
      this.assertLookReferenceOwnership(
        scope,
        input.characterId,
        lookId,
        content,
      );
      const version = this.repositories.lookVersions.insert(
        {
          id: versionId,
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          lookId,
          previousVersionId: null,
          content,
        },
        "DUPLICATE_VERSION_ID",
      );
      const look = this.repositories.looks.insert(
        {
          id: lookId,
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          characterId: input.characterId,
          status: "active",
          currentVersionId: versionId,
        },
        "DUPLICATE_ENTITY_ID",
      );
      return { look, version };
    });
  }

  getLook(scope: FamilyScope, characterId: string, lookId: string): Look {
    this.scopedCharacter(scope, characterId);
    const look = this.repositories.looks.get(lookId);
    if (!look) fail("LOOK_NOT_FOUND");
    if (look.characterId !== characterId) fail("FAMILY_SCOPE_MISMATCH");
    return look;
  }

  scopeForLookId(lookId: string): FamilyScope & { characterId: string } {
    this.parseId(lookId);
    const look = this.repositories.looks.get(lookId) ?? fail("LOOK_NOT_FOUND");
    return {
      ...this.scopeForCharacterId(look.characterId),
      characterId: look.characterId,
    };
  }

  getLookVersion(
    scope: FamilyScope,
    characterId: string,
    lookId: string,
    versionId: string,
  ): LookVersion {
    this.getLook(scope, characterId, lookId);
    const version = this.repositories.lookVersions.get(versionId);
    if (!version) fail("LOOK_VERSION_NOT_FOUND");
    if (version.lookId !== lookId) fail("FAMILY_SCOPE_MISMATCH");
    return version;
  }

  listLookVersions(
    scope: FamilyScope,
    characterId: string,
    lookId: string,
  ): LookVersion[] {
    this.getLook(scope, characterId, lookId);
    return lineageOrder(
      this.repositories.lookVersions.queryByField("lookId", lookId),
    );
  }

  listLooks(
    scope: FamilyScope,
    characterId: string,
    options: { includeArchived?: boolean } = {},
  ): Look[] {
    const character = this.scopedCharacter(scope, characterId);
    const looks = this.repositories.looks.queryByField(
      "characterId",
      characterId,
    );
    if (options.includeArchived) return looks;
    if (character.status === "archived") return [];
    return looks.filter((look) => look.status === "active");
  }

  appendLookVersion(
    scope: FamilyScope,
    input: {
      characterId: string;
      lookId: string;
      expectedVersionId: string;
      versionId?: string;
      content: LookContent;
      correlationId?: string;
    },
  ): { look: Look; version: LookVersion; events: ChangeEvent[] } {
    const content = lookContentSchema.parse(input.content);
    const versionId = this.newId(input.versionId);
    const correlationId = this.newId(input.correlationId);
    return this.store.transaction(() =>
      this.appendLookInTransaction(scope, {
        ...input,
        versionId,
        correlationId,
        content,
      }),
    );
  }

  revertLookVersion(
    scope: FamilyScope,
    input: {
      characterId: string;
      lookId: string;
      expectedVersionId: string;
      targetVersionId: string;
      versionId?: string;
      correlationId?: string;
    },
  ): { look: Look; version: LookVersion; events: ChangeEvent[] } {
    const target = this.getLookVersion(
      scope,
      input.characterId,
      input.lookId,
      input.targetVersionId,
    );
    return this.appendLookVersion(scope, { ...input, content: target.content });
  }

  archiveLook(
    scope: FamilyScope,
    characterId: string,
    lookId: string,
  ): { look: Look; events: ChangeEvent[] } {
    return this.setLookStatus(scope, characterId, lookId, "archived");
  }

  restoreLook(
    scope: FamilyScope,
    characterId: string,
    lookId: string,
  ): { look: Look; events: ChangeEvent[] } {
    return this.setLookStatus(scope, characterId, lookId, "active");
  }

  findDuplicateCharacters(
    scope: FamilyScope,
    input: {
      name: string;
      relationship: Relationship;
      sourceChecksum?: string;
    },
  ): DuplicateCandidate[] {
    this.scopedFamily(scope);
    if (input.sourceChecksum && !sha256Pattern.test(input.sourceChecksum))
      fail("INVALID_SOURCE_CHECKSUM");
    const normalizedName = normalizeDuplicateDisplayName(input.name);
    const normalizedRelationship = relationshipKey(input.relationship);
    return this.repositories.characters
      .queryByField("familyId", scope.familyId)
      .map((character) =>
        this.duplicateCandidate(
          character,
          normalizedName,
          normalizedRelationship,
          input.sourceChecksum,
        ),
      )
      .filter(
        (candidate): candidate is DuplicateCandidate => candidate !== null,
      );
  }

  assertCharacterSelection(
    scope: FamilyScope,
    characterIds: string[],
  ): Character[] {
    const { customer, family } = this.scopedFamily(scope);
    this.assertFamilyAnchorAvailable(family);
    this.assertActive(customer.status, family.status);
    return characterIds.map((id) => {
      const character = this.scopedCharacter(scope, id);
      this.assertActive(character.status);
      return character;
    });
  }

  listChangeEvents(): ChangeEvent[] {
    return this.repositories.changeEvents.list();
  }

  protected scopedCharacter(
    scope: FamilyScope,
    characterId: string,
  ): Character {
    this.scopedFamily(scope);
    this.parseId(characterId);
    const character = this.repositories.characters.get(characterId);
    if (!character) fail("CHARACTER_NOT_FOUND");
    if (character.familyId !== scope.familyId) fail("FAMILY_SCOPE_MISMATCH");
    return character;
  }

  protected assertCharacterMutable(
    scope: FamilyScope,
    characterId: string,
  ): Character {
    const { customer, family } = this.scopedFamily(scope);
    const character = this.scopedCharacter(scope, characterId);
    this.assertActive(customer.status, family.status, character.status);
    return character;
  }

  protected currentCharacterVersion(character: Character): CharacterVersion {
    return (
      this.repositories.characterVersions.get(character.currentVersionId) ??
      fail("CHARACTER_VERSION_NOT_FOUND")
    );
  }

  protected currentLookVersion(look: Look): LookVersion {
    return (
      this.repositories.lookVersions.get(look.currentVersionId) ??
      fail("LOOK_VERSION_NOT_FOUND")
    );
  }

  private insertInitialCharacter(
    family: Family,
    characterId: string,
    versionId: string,
    profile: CharacterProfile,
  ): { character: Character; version: CharacterVersion } {
    const at = this.now();
    const version = this.repositories.characterVersions.insert(
      {
        id: versionId,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        characterId,
        previousVersionId: null,
        profile,
      },
      "DUPLICATE_VERSION_ID",
    );
    const character = this.repositories.characters.insert(
      {
        id: characterId,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        familyId: family.id,
        status: "active",
        currentVersionId: versionId,
      },
      "DUPLICATE_ENTITY_ID",
    );
    if (!family.anchorCharacterId)
      this.repositories.families.update({
        ...family,
        anchorCharacterId: characterId,
        updatedAt: at,
      });
    return { character, version };
  }

  private appendCharacterInTransaction(
    scope: FamilyScope,
    input: {
      characterId: string;
      expectedVersionId: string;
      versionId: string;
      profile: CharacterProfile;
      correlationId: string;
    },
  ): {
    character: Character;
    version: CharacterVersion;
    events: ChangeEvent[];
  } {
    const character = this.assertCharacterMutable(scope, input.characterId);
    this.assertCharacterAppendPreconditions(scope, character, input);
    const previous = this.currentCharacterVersion(character);
    const at = this.now();
    const version = this.repositories.characterVersions.insert(
      {
        id: input.versionId,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        characterId: character.id,
        previousVersionId: previous.id,
        profile: input.profile,
      },
      "DUPLICATE_VERSION_ID",
    );
    const updated = this.repositories.characters.update({
      ...character,
      currentVersionId: version.id,
      updatedAt: at,
    });
    const events = this.appendClassifiedEvents(
      "character",
      character.id,
      previous.id,
      version.id,
      input.correlationId,
      classifyCharacterChange(previous.profile, version.profile),
    );
    return { character: updated, version, events };
  }

  private appendLookInTransaction(
    scope: FamilyScope,
    input: {
      characterId: string;
      lookId: string;
      expectedVersionId: string;
      versionId: string;
      content: LookContent;
      correlationId: string;
    },
  ): { look: Look; version: LookVersion; events: ChangeEvent[] } {
    this.assertCharacterMutable(scope, input.characterId);
    const look = this.getLook(scope, input.characterId, input.lookId);
    this.assertLookAppendPreconditions(scope, look, input);
    const previous = this.currentLookVersion(look);
    const at = this.now();
    const version = this.repositories.lookVersions.insert(
      {
        id: input.versionId,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        lookId: look.id,
        previousVersionId: previous.id,
        content: input.content,
      },
      "DUPLICATE_VERSION_ID",
    );
    const updated = this.repositories.looks.update({
      ...look,
      currentVersionId: version.id,
      updatedAt: at,
    });
    const events = this.appendClassifiedEvents(
      "look",
      look.id,
      previous.id,
      version.id,
      input.correlationId,
      classifyLookChange(previous.content, version.content),
    );
    return { look: updated, version, events };
  }

  private appendClassifiedEvents(
    entity: "character" | "look",
    entityId: string,
    fromVersionId: string,
    toVersionId: string,
    correlationId: string,
    changes: ClassifiedChange[],
  ): ChangeEvent[] {
    const at = this.now();
    return changes.map((change) =>
      this.repositories.changeEvents.insert(
        {
          id: this.newId(),
          schemaVersion: 1,
          createdAt: at,
          updatedAt: at,
          entity,
          entityId,
          fromVersionId,
          toVersionId,
          ...change,
          correlationId,
          occurredAt: at,
        },
        "DUPLICATE_ENTITY_ID",
      ),
    );
  }

  private setCharacterStatus(
    scope: FamilyScope,
    characterId: string,
    status: Character["status"],
  ): { character: Character; events: ChangeEvent[] } {
    return this.store.transaction(() => {
      const current = this.scopedCharacter(scope, characterId);
      if (current.status === status) return { character: current, events: [] };
      const character = this.repositories.characters.update({
        ...current,
        status,
        updatedAt: this.now(),
      });
      return { character, events: [this.appendVisibilityEvent(characterId)] };
    });
  }

  private setLookStatus(
    scope: FamilyScope,
    characterId: string,
    lookId: string,
    status: Look["status"],
  ): { look: Look; events: ChangeEvent[] } {
    return this.store.transaction(() => {
      const current = this.getLook(scope, characterId, lookId);
      if (current.status === status) return { look: current, events: [] };
      const look = this.repositories.looks.update({
        ...current,
        status,
        updatedAt: this.now(),
      });
      return { look, events: [this.appendVisibilityEvent(lookId)] };
    });
  }

  private assertRelationshipUpdate(
    familyId: string,
    character: Character,
    relationship: Relationship,
  ): void {
    const family =
      this.repositories.families.get(familyId) ?? fail("FAMILY_NOT_FOUND");
    const isAnchor = family.anchorCharacterId === character.id;
    if (isAnchor && relationship.type !== "main_child")
      fail("FAMILY_ANCHOR_IMMUTABLE");
    if (!isAnchor && relationship.type === "main_child")
      fail("FAMILY_ANCHOR_IMMUTABLE");
  }

  private assertCharacterAppendPreconditions(
    scope: FamilyScope,
    character: Character,
    input: {
      expectedVersionId: string;
      versionId: string;
      profile: CharacterProfile;
    },
  ): void {
    if (character.currentVersionId !== input.expectedVersionId)
      fail("STALE_VERSION_HEAD");
    if (this.repositories.characterVersions.get(input.versionId))
      fail("DUPLICATE_VERSION_ID");
    this.assertRelationshipUpdate(
      scope.familyId,
      character,
      input.profile.relationship,
    );
    this.assertCharacterReferenceOwnership(scope, character.id, input.profile);
  }

  private assertLookAppendPreconditions(
    scope: FamilyScope,
    look: Look,
    input: {
      characterId: string;
      expectedVersionId: string;
      versionId: string;
      content: LookContent;
    },
  ): void {
    this.assertActive(look.status);
    if (look.currentVersionId !== input.expectedVersionId)
      fail("STALE_VERSION_HEAD");
    if (this.repositories.lookVersions.get(input.versionId))
      fail("DUPLICATE_VERSION_ID");
    this.assertLookReferenceOwnership(
      scope,
      input.characterId,
      look.id,
      input.content,
    );
  }

  private duplicateCandidate(
    character: Character,
    normalizedName: string,
    normalizedRelationship: string,
    sourceChecksum?: string,
  ): DuplicateCandidate | null {
    const current = this.currentCharacterVersion(character);
    const matches: DuplicateCandidate["matches"] = [];
    if (
      normalizeDuplicateDisplayName(current.profile.name) === normalizedName &&
      relationshipKey(current.profile.relationship) === normalizedRelationship
    )
      matches.push("normalized_name_relationship");
    if (
      sourceChecksum &&
      this.profileHasChecksum(current.profile, sourceChecksum)
    )
      matches.push("source_checksum");
    return matches.length === 0
      ? null
      : { characterId: character.id, currentVersionId: current.id, matches };
  }

  private profileHasChecksum(
    profile: CharacterProfile,
    checksum: string,
  ): boolean {
    return profile.referencePhotoIds.some((photoId) => {
      const photo = this.repositories.referencePhotos.get(photoId);
      if (!photo) return false;
      return (
        this.repositories.originalAssets.get(photo.originalAssetId)?.sha256 ===
        checksum
      );
    });
  }

  private assertCharacterReferenceOwnership(
    scope: FamilyScope,
    characterId: string,
    profile: CharacterProfile,
  ): void {
    for (const photoId of profile.referencePhotoIds) {
      const photo = this.repositories.referencePhotos.get(photoId);
      if (
        !photo ||
        photo.customerId !== scope.customerId ||
        photo.familyId !== scope.familyId ||
        photo.owner.type !== "character" ||
        photo.owner.characterId !== characterId
      )
        fail("REFERENCE_PHOTO_OWNERSHIP_MISMATCH");
    }
  }

  private assertLookReferenceOwnership(
    scope: FamilyScope,
    characterId: string,
    lookId: string,
    content: LookContent,
  ): void {
    for (const photoId of content.referencePhotoIds) {
      const photo = this.repositories.referencePhotos.get(photoId);
      if (
        !photo ||
        photo.customerId !== scope.customerId ||
        photo.familyId !== scope.familyId ||
        photo.owner.type !== "look" ||
        photo.owner.characterId !== characterId ||
        photo.owner.lookId !== lookId
      )
        fail("REFERENCE_PHOTO_OWNERSHIP_MISMATCH");
    }
  }
}

function lineageOrder<
  T extends { id: string; previousVersionId: string | null },
>(values: T[]): T[] {
  const byPrevious = new Map(
    values.map((value) => [value.previousVersionId, value]),
  );
  const ordered: T[] = [];
  let current = byPrevious.get(null);
  while (current) {
    ordered.push(current);
    current = byPrevious.get(current.id);
  }
  return ordered.length === values.length ? ordered : values;
}
