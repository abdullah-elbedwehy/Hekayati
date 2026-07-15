import sharp from "sharp";

import type {
  PreviewCompositionPage,
  PreviewDocumentImage,
  PreviewTextBlock,
} from "../../src/pdf/composition-document.js";

export async function syntheticPreviewSource(): Promise<Buffer> {
  return await sharp({
    create: {
      width: 1_400,
      height: 1_900,
      channels: 3,
      background: { r: 238, g: 210, b: 116 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="1400" height="1900"><circle cx="700" cy="760" r="430" fill="#2F9E6A"/><rect x="210" y="1260" width="980" height="260" rx="80" fill="#FF8A1F"/></svg>',
        ),
      },
    ])
    .png()
    .toBuffer();
}

export function canonicalPreviewPages(
  image?: PreviewDocumentImage,
  hostileText = false,
  interiorPageCount: 16 | 24 = 16,
): PreviewCompositionPage[] {
  const storyPages = Array.from(
    { length: interiorPageCount - 4 },
    (_, index) => {
      const body =
        index % 5 === 2 || index % 5 === 3
          ? `قالت نور: نكمل الرحلة 2026!`
          : `في الصفحة ${index + 1}، قال أحمد الطويل-الاسم: لَأَلْعَبَنَّ مع نور وMira 2026!`;
      return page(
        "story",
        index + 3,
        body,
        image,
        hostileText && index === 0
          ? '<script src="https://outside.invalid/leak.js">سر</script>'
          : undefined,
        storyVisual(index),
      );
    },
  );
  return [
    page("front_cover", null, "حكاية أحمد في ملعب الليمون", image),
    page("title", 1, "حكاية أحمد", image),
    page("dedication", 2, "إلى أحمد، لأن خيالك يفتح كل الأبواب."),
    ...storyPages,
    page(
      "farewell",
      interiorPageCount - 1,
      "وهكذا عاد أحمد سعيدًا، والحكاية لسه بتبدأ.",
      image,
    ),
    page("brand", interiorPageCount, "حكايتي — حكاية معمولة بحب لأحمد"),
    page("back_cover", null, "هدية صغيرة تحمل مغامرة كبيرة."),
  ];
}

function page(
  kind: PreviewCompositionPage["kind"],
  interiorPageNumber: number | null,
  body: string,
  image?: PreviewDocumentImage,
  appendedText?: string,
  visual?: StoryVisual,
): PreviewCompositionPage {
  return {
    kind,
    interiorPageNumber,
    image,
    text: textBlock(body, appendedText, visual),
    ...(visual?.bubbles ? { bubbles: visual.bubbles } : {}),
  };
}

function textBlock(
  body: string,
  appendedText?: string,
  visual?: StoryVisual,
): PreviewTextBlock {
  return {
    heading: body,
    body: appendedText,
    region: visual?.region ?? { x: 0.1, y: 0.15, width: 0.8, height: 0.45 },
    fontSizePt: 20,
    aid: visual?.aid ?? "panel",
  };
}

interface StoryVisual {
  region: PreviewTextBlock["region"];
  aid: PreviewTextBlock["aid"];
  bubbles?: PreviewCompositionPage["bubbles"];
}

function storyVisual(index: number): StoryVisual {
  const variants: StoryVisual[] = [
    { region: { x: 0.1, y: 0.08, width: 0.8, height: 0.28 }, aid: "none" },
    {
      region: { x: 0.1, y: 0.64, width: 0.8, height: 0.28 },
      aid: "gradient",
    },
    { region: { x: 0.58, y: 0.18, width: 0.34, height: 0.58 }, aid: "panel" },
    { region: { x: 0.08, y: 0.18, width: 0.34, height: 0.58 }, aid: "panel" },
    {
      region: { x: 0.18, y: 0.28, width: 0.64, height: 0.38 },
      aid: "gradient",
      bubbles: [
        {
          speakerLabel: "نور",
          body: "أنا هنا — 2026!",
          region: { x: 0.55, y: 0.08, width: 0.34, height: 0.16 },
          pointer: { x: 0.7, y: 0.28 },
        },
      ],
    },
  ];
  return variants[index % variants.length];
}
