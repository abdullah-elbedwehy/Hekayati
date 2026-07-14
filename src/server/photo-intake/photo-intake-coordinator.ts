import { ulid } from "ulid";

import type { AssetStore, PreparedAsset } from "../../assets/asset-store.js";
import type {
  OriginalAssetStore,
  PreparedOriginalAsset,
} from "../../assets/original-asset-store.js";
import {
  PhotoIntakeError,
  PhotoIntakeProcessor,
  SharpLocalPhotoImageAdapter,
  type PhotoObservations,
  type PhotoQualityWarning,
  type PreparedPhoto,
  type PreparedPhotoValue,
  type ReferencePhotoKind,
  type StagedPhoto,
  type SubjectRectangle,
} from "../../assets/photo-intake/index.js";
import {
  characterProfileSchema,
  type CharacterProfile,
  type FamilyScope,
  type NewReferencePhoto,
  type ReferencePhoto,
} from "../../domain/library/index.js";
import type { LibraryService } from "../../domain/library/index.js";
import type { DocumentStore } from "../../domain/repository/document-store.js";
import type { SettingsService } from "../../domain/settings/settings.js";
import {
  toSafeReferencePhotoView,
  type SafeReferencePhotoView,
} from "../reference-photo-view.js";
import { PhotoReservationStore } from "./reservations.js";

const MEBIBYTE = 1024 * 1024;
const MEGAPIXEL = 1_000_000;

export type PhotoStageOwner =
  | { type: "character"; characterId: string }
  | { type: "look"; characterId: string; lookId: string }
  | { type: "new_character"; draft: CharacterProfile };

export interface LibraryPhotoStageInput {
  source: AsyncIterable<Uint8Array>;
  familyId: string;
  kind: ReferencePhotoKind;
  owner: PhotoStageOwner;
}

export interface LibraryPhotoCommitInput {
  reservationToken: string;
  subjectSelection?: SubjectRectangle;
  subjectSelectionConfirmed?: boolean;
  intendedPersonConfirmed?: boolean;
  observations: PhotoObservations;
  duplicateDecision:
    | { action: "create_separate" }
    | { action: "open_existing"; characterId: string };
}

export interface LibraryPhotoCommitResult {
  action: "attached" | "opened_existing";
  characterId: string;
  referencePhotoId?: string;
  referencePhoto?: SafeReferencePhotoView;
}

export interface LibraryPhotoStageResult {
  reservationToken: string;
  thumbnailUrl: string;
  widthPx: number;
  heightPx: number;
  kind: ReferencePhotoKind;
  warnings: Array<ReturnType<typeof toUiWarning>>;
  duplicateCandidates: Array<{
    characterId: string;
    name: string;
    relationship: CharacterProfile["relationship"]["type"];
    reasons: Array<"normalized_name_relationship" | "exact_source_checksum">;
  }>;
  expiresAt: string;
}

type ReservationOwner =
  | {
      type: "character";
      characterId: string;
      expectedVersionId: string;
      priorPhotos: ReferencePhoto[];
    }
  | {
      type: "look";
      characterId: string;
      lookId: string;
      expectedVersionId: string;
      priorPhotos: ReferencePhoto[];
    }
  | {
      type: "new_character";
      draft: CharacterProfile;
    };

class LibraryPhotoReservation {
  constructor(
    readonly staged: StagedPhoto,
    readonly scope: FamilyScope,
    readonly owner: ReservationOwner,
    readonly duplicateCharacterIds: readonly string[],
  ) {}

  cleanup(): void {
    this.staged.cleanup();
  }
}

export class PhotoIntakeCoordinator {
  private readonly reservations =
    new PhotoReservationStore<LibraryPhotoReservation>();
  private commitTail = Promise.resolve();

  constructor(
    private readonly store: DocumentStore,
    private readonly assets: AssetStore,
    private readonly originals: OriginalAssetStore,
    private readonly settings: SettingsService,
    private readonly library: LibraryService,
    private readonly processor = new PhotoIntakeProcessor(
      new SharpLocalPhotoImageAdapter(),
    ),
  ) {}

  currentMaxBytes(): number {
    return this.settings.get().photoUploadMaxMb * MEBIBYTE;
  }

  async stage(input: LibraryPhotoStageInput): Promise<LibraryPhotoStageResult> {
    const scope = this.library.scopeForFamilyId(input.familyId);
    const owner = this.resolveOwner(scope, input.owner);
    const settings = this.settings.get();
    const staged = await this.processor.stage({
      source: input.source,
      kind: input.kind,
      limits: {
        maxBytes: settings.photoUploadMaxMb * MEBIBYTE,
        maxPixels: settings.photoMaxMegapixels * MEGAPIXEL,
      },
    });
    try {
      const duplicateCandidates = this.duplicates(scope, owner, staged);
      const reservation = this.reservations.create(
        new LibraryPhotoReservation(
          staged,
          scope,
          owner,
          duplicateCandidates.map((candidate) => candidate.characterId),
        ),
      );
      return {
        reservationToken: reservation.reservationToken,
        thumbnailUrl: `/api/library/photo-intake/previews/${reservation.previewId}`,
        widthPx: staged.value.workingDimensions.widthPx,
        heightPx: staged.value.workingDimensions.heightPx,
        kind: staged.value.kind,
        warnings: staged.value.preliminaryQuality.warnings.map(toUiWarning),
        duplicateCandidates,
        expiresAt: reservation.expiresAt,
      };
    } catch (error) {
      staged.cleanup();
      throw error;
    }
  }

  preview(previewId: string): { bytes: Buffer; mime: "image/jpeg" } {
    const reservation = this.reservations.preview(previewId);
    return {
      bytes: Buffer.from(reservation.staged.value.thumbnail.bytes),
      mime: "image/jpeg",
    };
  }

  commit(input: LibraryPhotoCommitInput): Promise<LibraryPhotoCommitResult> {
    return this.serializedCommit(() => this.commitNow(input));
  }

  cancel(reservationToken: string): void {
    this.reservations.cancel(reservationToken);
  }

  close(): void {
    this.reservations.close();
  }

  private async commitNow(
    input: LibraryPhotoCommitInput,
  ): Promise<LibraryPhotoCommitResult> {
    const reservation = this.reservations.require(input.reservationToken);
    const opened = this.openExisting(reservation, input);
    if (opened) return opened;
    const confirmed = this.assertSubjectSelection(reservation, input);
    const finalized = await this.processor.finalize(reservation.staged, {
      subjectSelection: input.subjectSelection
        ? {
            rectangle: input.subjectSelection,
            confirmedByOperator: confirmed,
          }
        : undefined,
      observations: input.observations,
      existingObservations: priorPhotos(reservation.owner).map(
        (photo) => photo.quality.observations,
      ),
      referenceCountAfterCommit: priorPhotos(reservation.owner).length + 1,
    });
    this.reservations.releaseWithoutCleanup(input.reservationToken);
    try {
      return await this.persist(reservation, finalized);
    } finally {
      finalized.cleanup();
    }
  }

  private openExisting(
    reservation: LibraryPhotoReservation,
    input: LibraryPhotoCommitInput,
  ): LibraryPhotoCommitResult | undefined {
    if (input.duplicateDecision.action !== "open_existing") return undefined;
    if (
      !reservation.duplicateCharacterIds.includes(
        input.duplicateDecision.characterId,
      )
    )
      throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
    this.reservations.cancel(input.reservationToken);
    return {
      action: "opened_existing",
      characterId: input.duplicateDecision.characterId,
    };
  }

  private assertSubjectSelection(
    reservation: LibraryPhotoReservation,
    input: LibraryPhotoCommitInput,
  ): boolean {
    const kind = reservation.staged.value.kind;
    if (kind === "face" && input.observations.peopleCount === undefined)
      throw new PhotoIntakeError("PHOTO_SUBJECT_SELECTION_REQUIRED");
    const multiplePeople = (input.observations.peopleCount ?? 0) > 1;
    const required = kind === "face" || multiplePeople;
    const confirmed = input.subjectSelectionConfirmed === true;
    if (
      required &&
      (!input.subjectSelection ||
        !confirmed ||
        (multiplePeople && input.intendedPersonConfirmed !== true))
    )
      throw new PhotoIntakeError("PHOTO_SUBJECT_SELECTION_REQUIRED");
    return confirmed;
  }

  private resolveOwner(
    scope: FamilyScope,
    owner: PhotoStageOwner,
  ): ReservationOwner {
    if (owner.type === "character") {
      const character = this.library.getCharacter(scope, owner.characterId);
      return {
        ...owner,
        expectedVersionId: character.currentVersionId,
        priorPhotos: this.library.listReferencePhotosForCharacter(
          scope,
          owner.characterId,
        ),
      };
    }
    if (owner.type === "look") {
      const look = this.library.getLook(scope, owner.characterId, owner.lookId);
      return {
        ...owner,
        expectedVersionId: look.currentVersionId,
        priorPhotos: this.library.listReferencePhotosForLook(
          scope,
          owner.characterId,
          owner.lookId,
        ),
      };
    }
    const sourceMode = owner.draft.sourceMode;
    if (sourceMode !== "photo" && sourceMode !== "both")
      throw new PhotoIntakeError("PHOTO_DECODE_FAILED");
    const draft = characterProfileSchema.parse({
      ...owner.draft,
      sourceMode,
      referencePhotoIds: [ulid()],
    });
    return { type: "new_character", draft };
  }

  private duplicates(
    scope: FamilyScope,
    owner: ReservationOwner,
    staged: StagedPhoto,
  ): LibraryPhotoStageResult["duplicateCandidates"] {
    if (owner.type !== "new_character") return [];
    return this.library
      .findDuplicateCharacters(scope, {
        name: owner.draft.name,
        relationship: owner.draft.relationship,
        sourceChecksum: staged.value.original.sha256,
      })
      .map((candidate) => {
        const character = this.library.getCharacter(
          scope,
          candidate.characterId,
        );
        const version = this.library.getCharacterVersion(
          scope,
          character.id,
          candidate.currentVersionId,
        );
        return {
          characterId: character.id,
          name: version.profile.name,
          relationship: version.profile.relationship.type,
          reasons: candidate.matches.map((match) =>
            match === "source_checksum"
              ? ("exact_source_checksum" as const)
              : ("normalized_name_relationship" as const),
          ),
        };
      });
  }

  private async persist(
    reservation: LibraryPhotoReservation,
    finalized: PreparedPhoto,
  ): Promise<LibraryPhotoCommitResult> {
    const value = finalized.value;
    const preparedOriginal = await this.originals.prepare({
      bytes: value.original.bytes,
      sourceMime: value.original.mime,
      extension: value.original.extension,
    });
    const preparedAssets: PreparedAsset[] = [];
    try {
      preparedAssets.push(
        await this.assets.prepare(
          derivedInput(value.working, "reference_photo"),
        ),
      );
      preparedAssets.push(
        await this.assets.prepare(derivedInput(value.thumbnail, "thumbnail")),
      );
      if (value.subjectCrop)
        preparedAssets.push(
          await this.assets.prepare(
            derivedInput(value.subjectCrop, "reference_photo"),
          ),
        );
      return this.persistPrepared(
        reservation,
        value,
        preparedOriginal,
        preparedAssets,
      );
    } catch (error) {
      await discardAll(
        this.originals,
        preparedOriginal,
        this.assets,
        preparedAssets,
      );
      throw error;
    }
  }

  private persistPrepared(
    reservation: LibraryPhotoReservation,
    value: PreparedPhotoValue,
    original: PreparedOriginalAsset,
    derived: PreparedAsset[],
  ): LibraryPhotoCommitResult {
    return this.store.transaction(() => {
      const originalRecord = this.originals.commitPrepared(original);
      const [working, thumbnail, crop] = derived.map((prepared) =>
        this.assets.commitPrepared(prepared),
      );
      if (!working || !thumbnail)
        throw new Error("PHOTO_PREPARED_ASSET_MISSING");
      const photo: NewReferencePhoto = {
        id: ulid(),
        kind: value.kind,
        originalAssetId: originalRecord.id,
        workingAssetId: working.id,
        thumbnailAssetId: thumbnail.id,
        providerAssetId: crop?.id ?? working.id,
        subjectSelection: value.subjectSelection ?? null,
        quality: toDomainQuality(value),
        usableAsFaceReference: value.kind === "face",
        supersedesPhotoId: null,
      };
      return this.attachPreparedPhoto(reservation, photo);
    });
  }

  private attachPreparedPhoto(
    reservation: LibraryPhotoReservation,
    photo: NewReferencePhoto,
  ): LibraryPhotoCommitResult {
    const owner = reservation.owner;
    if (owner.type === "character") {
      const result = this.library.attachReferencePhotoToCharacter(
        reservation.scope,
        {
          characterId: owner.characterId,
          expectedVersionId: owner.expectedVersionId,
          photo,
        },
      );
      return attached(owner.characterId, result.photo);
    }
    if (owner.type === "look") {
      const result = this.library.attachReferencePhotoToLook(
        reservation.scope,
        {
          characterId: owner.characterId,
          lookId: owner.lookId,
          expectedVersionId: owner.expectedVersionId,
          photo,
        },
      );
      return attached(owner.characterId, result.photo);
    }
    const { sourceMode, referencePhotoIds, ...profile } = owner.draft;
    if (referencePhotoIds.length !== 1)
      throw new Error("INVALID_STAGED_REFERENCE_PLACEHOLDER");
    const result = this.library.createPhotoOnlyCharacter(reservation.scope, {
      sourceMode: sourceMode as "photo" | "both",
      duplicateDecision: "create_separate",
      profile,
      photo,
    });
    return attached(result.character.id, result.photo);
  }

  private async serializedCommit<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.commitTail;
    let release: () => void = () => undefined;
    this.commitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function derivedInput(
  derivative: PreparedPhotoValue["working"],
  role: "reference_photo" | "thumbnail",
) {
  return {
    bytes: derivative.bytes,
    extension: derivative.extension,
    mime: derivative.mime,
    width: derivative.widthPx,
    height: derivative.heightPx,
    role,
    origin: "derived" as const,
    exifStripped: true,
  };
}

function toDomainQuality(value: PreparedPhotoValue): ReferencePhoto["quality"] {
  return {
    policyVersion: value.quality.policyVersion,
    metrics: {
      ...value.quality.metrics,
      subjectBoxAreaRatio: value.quality.metrics.subjectBoxAreaRatio ?? null,
    },
    warnings: value.quality.warnings.map((warning) =>
      warning.source === "local_check"
        ? {
            code: warning.code,
            source: warning.source,
            metric: warning.metric,
            threshold: warning.threshold,
          }
        : {
            code: warning.code,
            source: warning.source,
            details: `${warning.observation}:${warning.details}`,
          },
    ),
    observations: { ...value.quality.observations },
  };
}

function toUiWarning(warning: PhotoQualityWarning) {
  return warning.source === "local_check"
    ? {
        code: warning.code,
        source: warning.source,
        metric: warning.metric,
        threshold: warning.threshold,
      }
    : {
        code: warning.code,
        source: warning.source,
        details: `${warning.observation}:${warning.details}`,
      };
}

async function discardAll(
  originals: OriginalAssetStore,
  original: PreparedOriginalAsset,
  assets: AssetStore,
  derived: PreparedAsset[],
): Promise<void> {
  await Promise.allSettled([
    originals.discardPrepared(original),
    ...derived.map((prepared) => assets.discardPrepared(prepared)),
  ]);
}

function attached(
  characterId: string,
  referencePhoto: ReferencePhoto,
): LibraryPhotoCommitResult {
  return {
    action: "attached",
    characterId,
    referencePhotoId: referencePhoto.id,
    referencePhoto: toSafeReferencePhotoView(referencePhoto),
  };
}

function priorPhotos(owner: ReservationOwner): ReferencePhoto[] {
  return owner.type === "new_character" ? [] : owner.priorPhotos;
}
