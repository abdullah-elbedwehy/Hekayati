import type { AssetStore } from "../../assets/asset-store.js";
import type { OriginalAssetStore } from "../../assets/original-asset-store.js";
import type { ManagedDeletionCleanup } from "../../portability/deletion-cleanup.js";
import type { ImportDiskProbeInput } from "../../portability/disk-preflight.js";
import type { ManagedImportStore } from "../../portability/import.js";
import type { DocumentStore } from "../repository/document-store.js";
import type { ImportApplyMediaCoordinator } from "./import-apply-media.js";
import type { ImportCommitResult } from "./import-apply-model.js";
import type { ImportOperation } from "./import-model.js";
import type { ImportPlanTargetReader } from "./import-plan-target.js";
import type { ImportReplaceBoundary } from "./import-replace.js";
import type { PortabilityRegistry } from "./participants.js";
import type { PortabilityAction } from "./schemas.js";

export interface ImportApplyHooks {
  afterLockAcquired?(operation: Readonly<ImportOperation>): Promise<void> | void;
  afterSourceSnapshot?(
    operation: Readonly<ImportOperation>,
  ): Promise<void> | void;
  beforeDbCommit?(): void;
  afterDbCommit?(): Promise<void> | void;
  beforeCleanupVerification?(): Promise<void> | void;
}

export type ImportApplyMediaPort = Pick<
  ImportApplyMediaCoordinator,
  | "repository"
  | "reserveInTransaction"
  | "prepare"
  | "commitInTransaction"
  | "discard"
>;

export interface ImportCleanupPort {
  execute: ManagedDeletionCleanup["execute"];
  verify: ManagedDeletionCleanup["verify"];
}

export interface ImportApplyServiceOptions {
  store: DocumentStore;
  registry: PortabilityRegistry;
  assets: AssetStore;
  originals: OriginalAssetStore;
  managedImports: ManagedImportStore;
  cleanup: ImportCleanupPort;
  target?: ImportPlanTargetReader;
  reserveBytes?: number;
  nowIso?: () => string;
  idFactory?: () => string;
  diskPreflight?: (input: ImportDiskProbeInput) => Promise<unknown>;
  sourceLoader?: ImportApplySourceLoader;
  media?: ImportApplyMediaPort;
  replaceBoundary?: ImportReplaceBoundary;
  hooks?: ImportApplyHooks;
}

export type ImportApplySourceLoader = typeof import("../../portability/import-staging-reader.js").loadValidatedImportSource;

export interface ImportApplyResult {
  readonly action: PortabilityAction;
  readonly current: ImportOperation;
  readonly result: ImportCommitResult;
  readonly replayed: boolean;
}

export interface ImportApplyRecoveryResult {
  readonly resumed: readonly string[];
  readonly cleanupCompleted: readonly string[];
  readonly rollbackCompleted: readonly string[];
  readonly failed: readonly { operationId: string; failureCode: string }[];
}

