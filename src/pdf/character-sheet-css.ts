export const characterSheetCss = String.raw`
  @page { size: A5 landscape; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 210mm; height: 148mm; overflow: hidden; }
  body {
    direction: rtl;
    font-family: "Hekayati Arabic", sans-serif;
    color: #2d3a2f;
    background: #fffdf5;
    print-color-adjust: exact;
  }
  main {
    height: 148mm;
    padding: 8mm;
    display: grid;
    grid-template-columns: 34mm 1fr;
    grid-template-rows: 20mm 1fr;
    gap: 4mm;
    background:
      radial-gradient(circle at 8% 8%, rgba(255, 211, 79, .28), transparent 28mm),
      linear-gradient(145deg, #fffdf5, #f6fbf1);
  }
  header {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1.1mm solid #f4c542;
    padding: 0 1mm 3mm;
  }
  h1 { margin: 0; font-size: 19pt; line-height: 1.2; color: #185b49; }
  .brand { font-size: 9pt; color: #59665b; }
  aside {
    border: .4mm solid #dce7d6;
    border-radius: 4mm;
    padding: 3mm;
    background: rgba(255,255,255,.82);
    overflow: hidden;
  }
  aside h2 { margin: 0 0 2mm; font-size: 9pt; color: #185b49; }
  .references { display: grid; grid-template-columns: 1fr 1fr; gap: 2mm; }
  .references img {
    width: 100%;
    height: 24mm;
    object-fit: cover;
    border-radius: 2mm;
    border: .3mm solid #dce7d6;
  }
  .description-only { margin: 5mm 0; font-size: 8pt; color: #667467; }
  .views {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    grid-template-rows: 1fr 1fr;
    gap: 3mm;
    min-width: 0;
    min-height: 0;
  }
  .view-card {
    margin: 0;
    border: .4mm solid #dce7d6;
    border-radius: 3mm;
    background: #fff;
    padding: 2mm;
    display: grid;
    grid-template-rows: 1fr auto;
    min-width: 0;
    min-height: 0;
    break-inside: avoid;
  }
  .view-card img { width: 100%; height: 100%; min-height: 0; object-fit: contain; }
  .view-card figcaption {
    padding-top: 1mm;
    text-align: center;
    font-size: 7.5pt;
    line-height: 1.3;
    white-space: nowrap;
  }
  .view-face, .view-front, .view-threeQuarter { grid-column: span 2; }
  .view-fullBody, .view-mainOutfit { grid-column: span 3; }
`;
