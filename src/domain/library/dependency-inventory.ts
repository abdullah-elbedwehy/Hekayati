import type { LibraryRepositories } from "./repositories.js";

export interface DownstreamDependencyReference {
  slot: string;
  recordId: string;
  kind: string;
}

export interface LibraryDependencyInventory {
  customerIds: string[];
  familyIds: string[];
  characterIds: string[];
  characterVersionIds: string[];
  lookIds: string[];
  lookVersionIds: string[];
  referencePhotoIds: string[];
  originalAssetIds: string[];
  derivedAssetIds: string[];
  changeEventIds: string[];
  invalidationReceiptIds: string[];
  mediaReferences: Array<{
    referencePhotoId: string;
    originalAssetId: string;
    derivedAssetIds: string[];
  }>;
  assetReferenceCounts: Array<{
    namespace: "original" | "derived";
    assetId: string;
    references: number;
  }>;
  downstreamReferences: DownstreamDependencyReference[];
}

/** Read-only FR-005 handoff. It deliberately exposes no delete operation. */
export class LibraryDependencyInventoryReader {
  constructor(private readonly repositories: LibraryRepositories) {}

  forCustomer(customerId: string): LibraryDependencyInventory {
    const owned = this.collectOwnedRecords(customerId);
    const entityIds = new Set([
      customerId,
      ...owned.familyIds,
      ...owned.characterIds,
      ...owned.lookIds,
    ]);
    const events = this.repositories.changeEvents
      .list()
      .filter((event) => entityIds.has(event.entityId));
    const eventIds = new Set(events.map((event) => event.id));
    const receiptIds = this.repositories.invalidationReceipts
      .list()
      .filter((receipt) => eventIds.has(receipt.eventId))
      .map((receipt) => receipt.id);
    const mediaReferences = photoMediaReferences(owned.photos);
    return {
      customerIds: [customerId],
      familyIds: sorted(owned.familyIds),
      characterIds: sorted(owned.characterIds),
      characterVersionIds: sorted(owned.characterVersionIds),
      lookIds: sorted(owned.lookIds),
      lookVersionIds: sorted(owned.lookVersionIds),
      referencePhotoIds: sorted(owned.photos.map((photo) => photo.id)),
      originalAssetIds: sorted(
        owned.photos.map((photo) => photo.originalAssetId),
      ),
      derivedAssetIds: derivedAssetIds(owned.photos),
      changeEventIds: sorted(eventIds),
      invalidationReceiptIds: sorted(receiptIds),
      mediaReferences,
      assetReferenceCounts: referenceCounts(mediaReferences),
      downstreamReferences: [],
    };
  }

  private collectOwnedRecords(customerId: string) {
    const families = this.repositories.families.queryByField(
      "customerId",
      customerId,
    );
    const familyIds = new Set(families.map((family) => family.id));
    const characters = this.repositories.characters
      .list()
      .filter((character) => familyIds.has(character.familyId));
    const characterIds = new Set(characters.map((character) => character.id));
    const characterVersions = this.repositories.characterVersions
      .list()
      .filter((version) => characterIds.has(version.characterId));
    const looks = this.repositories.looks
      .list()
      .filter((look) => characterIds.has(look.characterId));
    const lookIds = new Set(looks.map((look) => look.id));
    const lookVersions = this.repositories.lookVersions
      .list()
      .filter((version) => lookIds.has(version.lookId));
    const photos = this.repositories.referencePhotos
      .list()
      .filter(
        (photo) =>
          photo.customerId === customerId && familyIds.has(photo.familyId),
      );
    return {
      familyIds,
      characterIds,
      characterVersionIds: characterVersions.map((version) => version.id),
      lookIds,
      lookVersionIds: lookVersions.map((version) => version.id),
      photos,
    };
  }
}

function derivedAssetIds(
  photos: Array<{
    workingAssetId: string;
    thumbnailAssetId: string;
    providerAssetId: string | null;
  }>,
): string[] {
  return sorted(
    photos.flatMap((photo) => [
      photo.workingAssetId,
      photo.thumbnailAssetId,
      ...(photo.providerAssetId ? [photo.providerAssetId] : []),
    ]),
  );
}

function photoMediaReferences(
  photos: Array<{
    id: string;
    originalAssetId: string;
    workingAssetId: string;
    thumbnailAssetId: string;
    providerAssetId: string | null;
  }>,
): LibraryDependencyInventory["mediaReferences"] {
  return photos
    .map((photo) => ({
      referencePhotoId: photo.id,
      originalAssetId: photo.originalAssetId,
      derivedAssetIds: sorted([
        photo.workingAssetId,
        photo.thumbnailAssetId,
        ...(photo.providerAssetId ? [photo.providerAssetId] : []),
      ]),
    }))
    .sort((left, right) =>
      left.referencePhotoId.localeCompare(right.referencePhotoId),
    );
}

function referenceCounts(
  references: LibraryDependencyInventory["mediaReferences"],
): LibraryDependencyInventory["assetReferenceCounts"] {
  const counts = new Map<string, number>();
  for (const reference of references) {
    increment(counts, `original:${reference.originalAssetId}`);
    for (const assetId of reference.derivedAssetIds)
      increment(counts, `derived:${assetId}`);
  }
  return [...counts]
    .map(([key, references]) => {
      const separator = key.indexOf(":");
      return {
        namespace: key.slice(0, separator) as "original" | "derived",
        assetId: key.slice(separator + 1),
        references,
      };
    })
    .sort((left, right) =>
      `${left.namespace}:${left.assetId}`.localeCompare(
        `${right.namespace}:${right.assetId}`,
      ),
    );
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}
