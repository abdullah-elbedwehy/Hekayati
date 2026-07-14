import { writeFile } from "node:fs/promises";

import {
  AssetStore,
  type AssetStoreHooks,
} from "../../src/assets/asset-store.js";
import { prepareDataPaths, resolveDataPaths } from "../../src/config/paths.js";
import { DocumentStore } from "../../src/domain/repository/document-store.js";

const [data, marker, phase] = process.argv.slice(2);
if (
  !data ||
  !marker ||
  (phase !== "after_temp_sync" && phase !== "after_rename_sync")
)
  process.exit(2);

const halt = async (): Promise<never> => {
  await writeFile(marker, phase, { mode: 0o600 });
  return new Promise<never>(() => setInterval(() => undefined, 10_000));
};
const hooks: AssetStoreHooks =
  phase === "after_temp_sync"
    ? { afterTempSync: halt }
    : { afterRenameSync: halt };
const paths = resolveDataPaths(data);
await prepareDataPaths(paths);
const store = new DocumentStore(paths.database);
const assets = new AssetStore(store, paths.assets, hooks);
await assets.put({
  bytes: Buffer.from("asset-crash-stage"),
  extension: "bin",
  mime: "application/octet-stream",
  origin: "derived",
  role: "thumbnail",
});
