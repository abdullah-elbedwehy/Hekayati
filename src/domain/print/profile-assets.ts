import type { AssetStore } from "../../assets/asset-store.js";
import { requireCmykIccProfile } from "../../print/icc.js";

export function isValidCmykOutputProfileAsset(
  assets: AssetStore,
  assetId: string,
  checksum: string,
): boolean {
  const asset = assets.get(assetId);
  if (
    !asset ||
    asset.role !== "icc_profile" ||
    asset.mime !== "application/vnd.iccprofile" ||
    asset.sha256 !== checksum
  )
    return false;
  try {
    return (
      requireCmykIccProfile(assets.readSync(assetId)).checksum === checksum
    );
  } catch {
    return false;
  }
}
