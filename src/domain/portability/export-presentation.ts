import {
  exportOperationSchema,
  portabilitySnapshotSchema,
  type ExportOperation,
  type PortabilitySnapshot,
} from "./export-model.js";

export type ExportPresentationStage =
  "waiting_quiescence" | "staging" | "ready" | "failed";

const warnings = Object.freeze({
  noAutomaticBackup: "لا يوجد نسخ احتياطي تلقائي في حكايتي.",
  exportIsNotBackup: "التصدير ليس نسخة احتياطية.",
  archiveContainsChildPhotos: "يحتوي الأرشيف على صور الأطفال.",
  externalCopies: "لا تستطيع حكايتي تتبّع النسخ المحفوظة خارجها أو حذفها.",
});

const stages = Object.freeze({
  waiting_quiescence: Object.freeze({
    label: "في انتظار اكتمال الأعمال الجارية",
    detail: "المشروع متوقف مؤقتًا. ننتظر انتهاء الأعمال التي بدأت قبل التصدير.",
  }),
  staging: Object.freeze({
    label: "جارٍ تجهيز ملف التصدير",
    detail: "اكتملت الأعمال الجارية، ويجري تجهيز المحتوى والتحقق منه.",
  }),
  ready: Object.freeze({
    label: "ملف التصدير جاهز",
    detail: "تم التحقق من الملف، ويمكن تنزيله الآن.",
  }),
  failed: Object.freeze({
    label: "تعذّر تجهيز ملف التصدير",
    detail: "لم يصبح ملف جديد جاهزًا. راجع رمز الخطأ ثم أعد المحاولة.",
  }),
});

export const ARABIC_EXPORT_PRESENTATION_COPY = Object.freeze({
  heading: "تصدير المشروع",
  warnings,
  stages,
});

export interface ExportContentSummary {
  readonly documentCount: number;
  readonly mediaCount: number;
  readonly totalUncompressedBytes: number;
}

export interface ExportPresentationReferences {
  readonly operationId: string;
  readonly projectId: string;
  readonly snapshotId: string | null;
  readonly snapshotHash: string | null;
  readonly manifestHash: string | null;
  readonly archiveChecksum: string | null;
  readonly failureCode: string | null;
}

export interface ProjectExportPresentation {
  readonly direction: "rtl";
  readonly stage: ExportPresentationStage;
  readonly references: Readonly<ExportPresentationReferences>;
  readonly pause: Readonly<{
    projectPaused: boolean;
    quiescenceReached: boolean;
    resumesAutomatically: false;
  }>;
  readonly content: Readonly<ExportContentSummary> | null;
  readonly canDownload: boolean;
  readonly copy: (typeof stages)[ExportPresentationStage];
  readonly warnings: typeof warnings;
}

export function projectExportPresentation(
  operationInput: ExportOperation,
  snapshotInput: PortabilitySnapshot | null = null,
): ProjectExportPresentation {
  const operation = exportOperationSchema.parse(operationInput);
  const snapshot = snapshotInput
    ? portabilitySnapshotSchema.parse(snapshotInput)
    : null;
  assertSnapshotMatches(operation, snapshot);
  const stage = presentationStage(operation.state);
  return Object.freeze({
    direction: "rtl" as const,
    stage,
    references: safeReferences(operation),
    pause: pauseSummary(operation),
    content: contentSummary(operation, snapshot),
    canDownload: operation.state === "ready",
    copy: stages[stage],
    warnings,
  });
}

function presentationStage(
  state: ExportOperation["state"],
): ExportPresentationStage {
  if (state === "ready") return "ready";
  if (state === "failed" || state === "stale") return "failed";
  if (
    state === "waiting_pause" ||
    state === "waiting_quiescence" ||
    state === "acquiring_lock"
  )
    return "waiting_quiescence";
  return "staging";
}

function safeReferences(
  operation: ExportOperation,
): Readonly<ExportPresentationReferences> {
  return Object.freeze({
    operationId: operation.id,
    projectId: operation.projectId,
    snapshotId: operation.snapshotId,
    snapshotHash: operation.snapshotHash,
    manifestHash: operation.manifestHash,
    archiveChecksum: operation.archiveChecksum,
    failureCode: operation.failureCode,
  });
}

function pauseSummary(operation: ExportOperation) {
  return Object.freeze({
    projectPaused: operation.state !== "waiting_pause",
    quiescenceReached: quiescenceReached(operation),
    resumesAutomatically: false as const,
  });
}

function quiescenceReached(operation: ExportOperation): boolean {
  if (operation.state === "failed" || operation.state === "stale")
    return hasFrozenSummary(operation);
  return [
    "freezing_snapshot",
    "staging",
    "packaging",
    "secret_scanning",
    "ready",
  ].includes(operation.state);
}

function contentSummary(
  operation: ExportOperation,
  snapshot: PortabilitySnapshot | null,
): Readonly<ExportContentSummary> | null {
  if (!hasFrozenSummary(operation)) return null;
  const source = snapshot ?? operation;
  return Object.freeze({
    documentCount: source.documentCount,
    mediaCount: source.mediaCount,
    totalUncompressedBytes: source.totalUncompressedBytes,
  });
}

function hasFrozenSummary(operation: ExportOperation): boolean {
  return (
    operation.snapshotId !== null &&
    operation.snapshotHash !== null &&
    operation.documentCount > 0 &&
    operation.totalUncompressedBytes > 0
  );
}

function assertSnapshotMatches(
  operation: ExportOperation,
  snapshot: PortabilitySnapshot | null,
): void {
  if (!snapshot) return;
  const operationFacts = [
    operation.snapshotId,
    operation.id,
    operation.projectId,
    operation.customerId,
    operation.familyId,
    operation.projectRevision,
    operation.snapshotHash,
    operation.documentCount,
    operation.mediaCount,
    operation.totalUncompressedBytes,
  ];
  const snapshotFacts = [
    snapshot.id,
    snapshot.operationId,
    snapshot.projectId,
    snapshot.customerId,
    snapshot.familyId,
    snapshot.projectRevision,
    snapshot.snapshotHash,
    snapshot.documentCount,
    snapshot.mediaCount,
    snapshot.totalUncompressedBytes,
  ];
  if (operationFacts.some((value, index) => value !== snapshotFacts[index]))
    throw new Error("PORTABILITY_EXPORT_PRESENTATION_SNAPSHOT_MISMATCH");
}
