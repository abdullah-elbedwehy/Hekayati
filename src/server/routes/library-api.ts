import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AssetStore } from "../../assets/asset-store.js";
import {
  characterProfileSchema,
  consentRecordSchema,
  entityIdSchema,
  lookContentSchema,
  type CharacterProfile,
  type CharacterVersion,
  type DuplicateCandidate,
  type Family,
  type FamilyScope,
  type LookVersion,
} from "../../domain/library/index.js";
import { LibraryError } from "../../domain/library/errors.js";
import type { LibraryService } from "../../domain/library/index.js";
import { CharacterCreatePreflightStore } from "../library/character-create-preflights.js";
import { toSafeReferencePhotoView } from "../reference-photo-view.js";

const customerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    whatsapp: z.string().max(100),
    notes: z.string().max(8_000),
  })
  .strict();

const consentInputSchema = z
  .object({ consent: consentRecordSchema.nullable() })
  .strict();

const familyInputSchema = z
  .object({ name: z.string().trim().min(1).max(240) })
  .strict();

const characterInputSchema = z
  .object({
    profile: characterProfileSchema,
    preflightToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    duplicateDecision: z
      .object({ action: z.literal("create_separate") })
      .strict()
      .optional(),
  })
  .strict();
const characterPreflightSchema = z
  .object({ profile: characterProfileSchema })
  .strict();

const characterUpdateSchema = z
  .object({
    expectedVersionId: entityIdSchema,
    intent: z.literal("update_base"),
    profile: characterProfileSchema,
  })
  .strict();

const lookInputSchema = lookContentSchema;
const lookUpdateSchema = lookContentSchema.extend({
  expectedVersionId: entityIdSchema,
});
const idParamSchema = z.object({ id: entityIdSchema }).strict();

export function registerLibraryApi(
  app: FastifyInstance,
  library: LibraryService,
  assets: AssetStore,
): void {
  const characterPreflights = new CharacterCreatePreflightStore();
  app.addHook("onClose", () => characterPreflights.close());
  app.get("/api/library", () => librarySnapshot(library));
  app.get(
    "/api/library/reference-photos/:id/thumbnail",
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const scope = library.scopeForReferencePhotoId(id);
      const photo = library.getReferencePhoto(scope, id);
      const thumbnail = assets.get(photo.thumbnailAssetId);
      if (
        !thumbnail ||
        thumbnail.role !== "thumbnail" ||
        thumbnail.origin !== "derived" ||
        thumbnail.exifStripped !== true ||
        (thumbnail.mime !== "image/jpeg" && thumbnail.mime !== "image/png")
      )
        throw new LibraryError("REFERENCE_ASSET_NOT_ELIGIBLE");
      return reply
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .type(thumbnail.mime)
        .send(await assets.read(thumbnail.id));
    },
  );
  registerCustomerRoutes(app, library);
  registerFamilyRoutes(app, library);
  registerCharacterRoutes(app, library, characterPreflights);
  registerLookRoutes(app, library);
}

function registerCustomerRoutes(
  app: FastifyInstance,
  library: LibraryService,
): void {
  app.post("/api/library/customers", (request) =>
    library.createCustomer(customerInputSchema.parse(request.body)),
  );
  app.patch("/api/library/customers/:id", (request) => {
    const { id } = idParamSchema.parse(request.params);
    return library.updateCustomer(id, customerInputSchema.parse(request.body));
  });
  app.post("/api/library/customers/:id/consent", (request) => {
    const { id } = idParamSchema.parse(request.params);
    const { consent } = consentInputSchema.parse(request.body);
    return consent
      ? library.recordConsent(id, consent)
      : library.clearConsent(id);
  });
  app.post("/api/library/customers/:id/archive", (request) =>
    library.archiveCustomer(idParamSchema.parse(request.params).id),
  );
  app.post("/api/library/customers/:id/restore", (request) =>
    library.restoreCustomer(idParamSchema.parse(request.params).id),
  );
}

function registerFamilyRoutes(
  app: FastifyInstance,
  library: LibraryService,
): void {
  app.post("/api/library/customers/:id/families", (request) => {
    const { id } = idParamSchema.parse(request.params);
    const input = familyInputSchema.parse(request.body);
    return toUiFamily(library.createFamily({ customerId: id, ...input }));
  });
  app.patch("/api/library/families/:id", (request) => {
    const scope = familyScope(library, request.params);
    return toUiFamily(
      library.updateFamily(scope, familyInputSchema.parse(request.body)),
    );
  });
  app.post("/api/library/families/:id/archive", (request) => {
    const scope = familyScope(library, request.params);
    return toUiFamily(library.archiveFamily(scope));
  });
  app.post("/api/library/families/:id/restore", (request) => {
    const scope = familyScope(library, request.params);
    return toUiFamily(library.restoreFamily(scope));
  });
}

function registerCharacterRoutes(
  app: FastifyInstance,
  library: LibraryService,
  preflights: CharacterCreatePreflightStore,
): void {
  registerCharacterCreateRoutes(app, library, preflights);
  registerCharacterLifecycleRoutes(app, library);
}

function registerCharacterCreateRoutes(
  app: FastifyInstance,
  library: LibraryService,
  preflights: CharacterCreatePreflightStore,
): void {
  app.post("/api/library/families/:id/characters/preflight", (request) => {
    const scope = familyScope(library, request.params);
    const { profile } = characterPreflightSchema.parse(request.body);
    const candidates = library.findDuplicateCharacters(scope, {
      name: profile.name,
      relationship: profile.relationship,
    });
    return {
      ...preflights.issue(
        scope.familyId,
        profile,
        candidates.map((candidate) => candidate.characterId),
      ),
      duplicateCandidates: candidates.map((candidate) =>
        toUiDuplicateCandidate(library, scope, candidate),
      ),
    };
  });
  app.post("/api/library/families/:id/characters", (request) => {
    const scope = familyScope(library, request.params);
    const input = characterInputSchema.parse(request.body);
    const candidates = library.findDuplicateCharacters(scope, {
      name: input.profile.name,
      relationship: input.profile.relationship,
    });
    preflights.consume({
      preflightToken: input.preflightToken,
      familyId: scope.familyId,
      profile: input.profile,
      candidateIds: candidates.map((candidate) => candidate.characterId),
      createSeparateConfirmed:
        input.duplicateDecision?.action === "create_separate",
    });
    const created = library.createCharacter(scope, {
      profile: input.profile,
      duplicateDecision:
        candidates.length > 0 ? input.duplicateDecision?.action : undefined,
    });
    return toUiCharacter(library, scope, created.character.id);
  });
}

function toUiDuplicateCandidate(
  library: LibraryService,
  scope: FamilyScope,
  candidate: DuplicateCandidate,
) {
  const version = library.getCharacterVersion(
    scope,
    candidate.characterId,
    candidate.currentVersionId,
  );
  return {
    characterId: candidate.characterId,
    currentVersionId: candidate.currentVersionId,
    name: version.profile.name,
    relationship: version.profile.relationship,
    reasons: candidate.matches,
  };
}

function registerCharacterLifecycleRoutes(
  app: FastifyInstance,
  library: LibraryService,
): void {
  app.patch("/api/library/characters/:id", (request) => {
    const { id } = idParamSchema.parse(request.params);
    const scope = library.scopeForCharacterId(id);
    const input = characterUpdateSchema.parse(request.body);
    library.appendCharacterVersion(scope, {
      characterId: id,
      expectedVersionId: input.expectedVersionId,
      profile: input.profile,
    });
    return toUiCharacter(library, scope, id);
  });
  app.post("/api/library/characters/:id/archive", (request) => {
    const { id } = idParamSchema.parse(request.params);
    const scope = library.scopeForCharacterId(id);
    library.archiveCharacter(scope, id);
    return toUiCharacter(library, scope, id);
  });
  app.post("/api/library/characters/:id/restore", (request) => {
    const { id } = idParamSchema.parse(request.params);
    const scope = library.scopeForCharacterId(id);
    library.restoreCharacter(scope, id);
    return toUiCharacter(library, scope, id);
  });
  app.get("/api/library/characters/:id/history", (request) => {
    const { id } = idParamSchema.parse(request.params);
    const scope = library.scopeForCharacterId(id);
    return library
      .listCharacterVersions(scope, id)
      .map((version) => toUiCharacterVersion(version));
  });
}

function registerLookRoutes(
  app: FastifyInstance,
  library: LibraryService,
): void {
  app.post("/api/library/characters/:id/looks", (request) => {
    const { id } = idParamSchema.parse(request.params);
    const scope = library.scopeForCharacterId(id);
    const content = lookInputSchema.parse(request.body);
    const created = library.createLook(scope, { characterId: id, content });
    return toUiLook(library, scope, id, created.look.id);
  });
  app.patch("/api/library/looks/:id", (request) => {
    const { id } = idParamSchema.parse(request.params);
    const located = library.scopeForLookId(id);
    const { expectedVersionId, ...content } = lookUpdateSchema.parse(
      request.body,
    );
    library.appendLookVersion(located, {
      characterId: located.characterId,
      lookId: id,
      expectedVersionId,
      content,
    });
    return toUiLook(library, located, located.characterId, id);
  });
  app.post("/api/library/looks/:id/archive", (request) => {
    const { id } = idParamSchema.parse(request.params);
    const located = library.scopeForLookId(id);
    library.archiveLook(located, located.characterId, id);
    return toUiLook(library, located, located.characterId, id);
  });
  app.post("/api/library/looks/:id/restore", (request) => {
    const { id } = idParamSchema.parse(request.params);
    const located = library.scopeForLookId(id);
    library.restoreLook(located, located.characterId, id);
    return toUiLook(library, located, located.characterId, id);
  });
  app.get("/api/library/looks/:id/history", (request) => {
    const { id } = idParamSchema.parse(request.params);
    const located = library.scopeForLookId(id);
    return library
      .listLookVersions(located, located.characterId, id)
      .map((version) => toUiLookVersion(version));
  });
}

function librarySnapshot(library: LibraryService) {
  const customers = library.listCustomers({ includeArchived: true });
  const families = customers.flatMap((customer) =>
    library
      .listFamilies(customer.id, { includeArchived: true })
      .map((family) => toUiFamily(family)),
  );
  const characters = families.flatMap((family) => {
    const scope = { customerId: family.customerId, familyId: family.id };
    return library
      .listCharacters(scope, { includeArchived: true })
      .map((character) => toUiCharacter(library, scope, character.id));
  });
  const looks = characters.flatMap((character) => {
    const scope = library.scopeForCharacterId(character.id);
    return library
      .listLooks(scope, character.id, { includeArchived: true })
      .map((look) => toUiLook(library, scope, character.id, look.id));
  });
  const characterPhotos = characters.flatMap((character) => {
    const scope = library.scopeForCharacterId(character.id);
    return library
      .listReferencePhotosForCharacter(scope, character.id)
      .map(toSafeReferencePhotoView);
  });
  const lookPhotos = looks.flatMap((look) => {
    const located = library.scopeForLookId(look.id);
    return library
      .listReferencePhotosForLook(located, located.characterId, look.id)
      .map(toSafeReferencePhotoView);
  });
  return {
    customers,
    families,
    characters,
    looks,
    referencePhotos: [...characterPhotos, ...lookPhotos],
  };
}

function toUiFamily(family: Family) {
  return {
    ...family,
    anchorCharacterId: family.anchorCharacterId ?? undefined,
  };
}

function toUiCharacter(
  library: LibraryService,
  scope: FamilyScope,
  characterId: string,
) {
  const character = library.getCharacter(scope, characterId);
  const versions = library.listCharacterVersions(scope, characterId);
  const current = library.getCharacterVersion(
    scope,
    characterId,
    character.currentVersionId,
  );
  return {
    ...character,
    currentVersion: toUiCharacterVersion(current),
    versionCount: versions.length,
  };
}

function toUiCharacterVersion(version: CharacterVersion) {
  return { ...version, profile: toUiProfile(version.profile) };
}

function toUiProfile(profile: CharacterProfile): CharacterProfile {
  return {
    ...profile,
    nickname: profile.nickname ?? "",
    ageOrRange: profile.ageOrRange ?? "",
    gender: profile.gender ?? "",
    skinTone: profile.skinTone ?? "",
    hair: profile.hair ?? "",
    eyeColor: profile.eyeColor ?? "",
    relativeHeight: profile.relativeHeight ?? "",
    build: profile.build ?? "",
    glasses: profile.glasses ?? "",
    hijab: profile.hijab ?? "",
    favoriteColor: profile.favoriteColor ?? "",
    speakingStyle: profile.speakingStyle ?? "",
    notes: profile.notes ?? "",
  };
}

function toUiLook(
  library: LibraryService,
  scope: FamilyScope,
  characterId: string,
  lookId: string,
) {
  const look = library.getLook(scope, characterId, lookId);
  const versions = library.listLookVersions(scope, characterId, lookId);
  const current = library.getLookVersion(
    scope,
    characterId,
    lookId,
    look.currentVersionId,
  );
  return {
    ...look,
    currentVersion: toUiLookVersion(current),
    versionCount: versions.length,
  };
}

function toUiLookVersion(version: LookVersion) {
  return { ...version, ...version.content };
}

function familyScope(library: LibraryService, params: unknown): FamilyScope {
  return library.scopeForFamilyId(idParamSchema.parse(params).id);
}
