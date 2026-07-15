export const previewCompositionCss = String.raw`
  @page { size: 210mm 297mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 210mm;
    background: #fff8e8;
  }
  body {
    direction: rtl;
    color: #2b2a28;
    font-family: "Hekayati Arabic", sans-serif;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
  .preview-page {
    position: relative;
    width: 210mm;
    height: 297mm;
    overflow: hidden;
    isolation: isolate;
    background:
      radial-gradient(circle at 8% 8%, rgba(255, 229, 102, .24), transparent 54mm),
      linear-gradient(145deg, #fffdf5, #fff8e8);
  }
  .preview-page:not(:last-child) { break-after: page; }
  .page-art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .page-shade {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, transparent 44%, rgba(19, 74, 50, .08));
    pointer-events: none;
  }
  .text-block {
    position: absolute;
    z-index: 2;
    padding: 6mm;
    line-height: 1.75;
    text-align: start;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    unicode-bidi: isolate;
  }
  .text-block h1,
  .text-block h2 {
    margin: 0 0 4mm;
    font-family: "Hekayati Brand", "Hekayati Arabic", sans-serif;
    line-height: 1.35;
    color: #134a32;
  }
  .text-block p { margin: 0; }
  .aid-panel {
    border: .35mm solid rgba(31, 111, 74, .22);
    border-radius: 4mm;
    background: rgba(255, 248, 232, .92);
  }
  .aid-gradient {
    border-radius: 4mm;
    background: linear-gradient(90deg, rgba(255, 248, 232, .96), rgba(255, 248, 232, .72));
  }
  .dialogue-bubble {
    position: absolute;
    z-index: 3;
    padding: 4mm 5mm;
    border: .35mm solid rgba(31, 111, 74, .35);
    border-radius: 7mm;
    background: rgba(255, 253, 245, .96);
    color: #2b2a28;
    font-size: 14pt;
    line-height: 1.55;
    overflow: hidden;
    unicode-bidi: isolate;
  }
  .dialogue-speaker {
    display: block;
    margin-bottom: 1mm;
    color: #1f6f4a;
    font-weight: 700;
  }
  .dialogue-pointer {
    position: absolute;
    width: 5mm;
    height: 5mm;
    border: solid rgba(31, 111, 74, .35);
    border-width: 0 .35mm .35mm 0;
    background: #fffdf5;
    transform: rotate(45deg);
  }
  .preview-watermark {
    position: absolute;
    z-index: 20;
    top: 50%;
    left: 50%;
    width: 170mm;
    transform: translate(-50%, -50%) rotate(-32deg);
    color: rgba(31, 111, 74, .20);
    font-family: "Hekayati Brand", "Hekayati Arabic", sans-serif;
    font-size: 48pt;
    font-weight: 700;
    line-height: 1.2;
    text-align: center;
    white-space: nowrap;
    pointer-events: none;
    unicode-bidi: isolate;
  }
  .preview-footer {
    position: absolute;
    z-index: 21;
    right: 12mm;
    bottom: 5mm;
    left: 12mm;
    display: flex;
    justify-content: space-between;
    gap: 8mm;
    padding-top: 2mm;
    border-top: .25mm solid rgba(43, 42, 40, .22);
    color: #5c574f;
    font-size: 8pt;
    line-height: 1.3;
    unicode-bidi: isolate;
  }
  .kind-front_cover .text-block,
  .kind-back_cover .text-block,
  .kind-title .text-block,
  .kind-farewell .text-block {
    text-align: center;
  }
  .kind-brand {
    background: linear-gradient(145deg, #ff8a1f, #f17b13);
  }
  .kind-brand .text-block { color: #fffdf5; text-align: center; }
  .kind-brand .text-block h1,
  .kind-brand .text-block h2 { color: #ffe566; }
`;
