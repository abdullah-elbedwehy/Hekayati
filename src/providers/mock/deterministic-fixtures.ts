import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import type { ResolvedImageRequest } from "../contract.js";
import type { GenerationTaskV1 } from "../generation-task.js";
import { MANDATORY_NEGATIVE_CONSTRAINTS } from "../prompt/styles.js";
import { canonicalJson } from "../provenance.js";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

export function deterministicHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function deterministicStructuredFixture(
  task: GenerationTaskV1,
  hash: string,
): unknown {
  switch (task.schemaId) {
    case "StoryPlan":
      return storyPlanFixture(task, hash);
    case "StoryText":
      return storyTextFixture(task);
    case "SceneList":
      return sceneListFixture(task);
    case "PagePrompt":
      return pagePromptFixture(task, hash);
    case "ReviewFindings":
      return { schemaVersion: 1, findings: [] };
  }
}

export function deterministicImageHash(request: ResolvedImageRequest): string {
  const referenceImages = request.referenceImages.map(
    ({ bytes, ...reference }) => ({
      ...reference,
      byteCount: bytes.byteLength,
      bytesHash: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  return deterministicHash({ ...request, referenceImages });
}

export function deterministicPng(hash: string): Uint8Array {
  const color = Buffer.from(hash, "hex").subarray(0, 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const pixel = Buffer.from([0, color[0], color[1], color[2], 255]);
  return new Uint8Array(
    Buffer.concat([
      PNG_SIGNATURE,
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(pixel)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function pngChunk(type: "IHDR" | "IDAT" | "IEND", data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storyPlanFixture(
  task: Extract<GenerationTaskV1, { schemaId: "StoryPlan" }>,
  hash: string,
) {
  return {
    schemaVersion: 1,
    title: `${task.payload.workingTitle} ${hash.slice(0, 6)}`,
    logline: task.payload.premise,
    arc: Array.from({ length: task.payload.pageCount }, (_, index) => ({
      beat: `محطة ${index + 1}`,
      purpose: "تقدّم لطيف في الحكاية",
      pagesEstimate: 1,
    })),
    settingSummary: "مكان مصري دافئ وواضح بصريًا.",
    characterArcs: task.participants.map((participant) => ({
      characterRef: participant.characterRef,
      arcNote: `يتقدّم دور ${participant.displayLabel} بالأفعال من غير وعظ.`,
    })),
    hiddenGoalWeave: task.payload.hiddenGoal,
    toneNotes: "لغة مصرية طبيعية وإيقاع دافئ.",
    pageBudget: { storyPages: task.payload.pageCount },
  };
}

function storyTextFixture(
  task: Extract<GenerationTaskV1, { schemaId: "StoryText" }>,
) {
  return {
    schemaVersion: 1,
    pages: Array.from({ length: task.payload.pageCount }, (_, index) => ({
      pageNumber: index + 1,
      narrative: narrative(task.payload.wordsPerPage.minimum, index + 1),
      dialogue: [],
    })),
  };
}

function sceneListFixture(
  task: Extract<GenerationTaskV1, { schemaId: "SceneList" }>,
) {
  return {
    schemaVersion: 1,
    scenes: task.payload.storyPages.map((page) => ({
      pageNumber: page.pageNumber,
      purpose: "تحريك الحكاية بصريًا",
      description: `مشهد أصلي للصفحة ${page.pageNumber} من غير أي كتابة.`,
      participants: task.participants.map((item) => item.characterRef),
      perCharacter: task.participants.map((item) => ({
        characterRef: item.characterRef,
        action: "يتفاعل مع الحدث",
        emotion: "فضولي وسعيد",
        position: null,
        framing: null,
        lookId: item.availableLookIds[0] ?? null,
        heldObject: null,
        gazeTarget: null,
        speaks: false,
      })),
      environment: "بيئة دافئة مناسبة للأطفال",
      timeOfDay: "صباح",
      composition: "تكوين متوازن وواضح",
      cameraFraming: "لقطة متوسطة",
      twoImageMoment: false,
    })),
  };
}

function pagePromptFixture(
  task: Extract<GenerationTaskV1, { schemaId: "PagePrompt" }>,
  hash: string,
) {
  return {
    schemaVersion: 1,
    pageNumber: task.payload.pageNumber,
    prompt: `مشهد أطفال أصلي ${hash.slice(0, 8)} في ${task.payload.scene.environment}.`,
    negativeConstraints: [...MANDATORY_NEGATIVE_CONSTRAINTS],
    referencePlan: task.payload.scene.participantRefs.map((characterRef) => ({
      characterRef,
      useSheetViews: ["face", "front"],
    })),
  };
}

function narrative(minimumWords: number, pageNumber: number): string {
  const words = [
    "في",
    "الصباح",
    "بدأت",
    "المغامرة",
    "بضحكة",
    "صغيرة",
    "وخطوة",
    "شجاعة",
    `رقم${pageNumber}`,
  ];
  while (words.length < minimumWords) words.push("بهدوء");
  return words.join(" ");
}
