import { useState } from "react";

import type { ApiClient } from "../../api";
import type { CreativePage, CreativeSheet } from "../../creative-types";

interface ConsistencyCompareProps {
  client: ApiClient;
  familyId: string;
  page: CreativePage;
  sheets: CreativeSheet[];
}

export function ConsistencyCompare({
  client,
  familyId,
  page,
  sheets,
}: ConsistencyCompareProps) {
  const [crop, setCrop] = useState({ zoom: 1.45, x: 50, y: 40 });
  return (
    <section className="consistency-compare" aria-labelledby="compare-title">
      <div className="compare-heading">
        <div>
          <p className="eyebrow">مقارنة مباشرة</p>
          <h3 id="compare-title">هوية الصفحة مقابل الورقة المعتمدة</h3>
        </div>
        <p>حرّك القصّ بلوحة المفاتيح لفحص الوجه والملابس بوضوح.</p>
      </div>
      <div className="compare-stage">
        <PageCrop client={client} familyId={familyId} page={page} crop={crop} />
        <div className="sheet-reference-grid">
          {sheets.map((sheet) => (
            <SheetReference
              key={sheet.id}
              client={client}
              familyId={familyId}
              sheet={sheet}
            />
          ))}
        </div>
      </div>
      <CropControls crop={crop} onCrop={setCrop} />
    </section>
  );
}

function PageCrop({
  client,
  familyId,
  page,
  crop,
}: Omit<ConsistencyCompareProps, "sheets"> & {
  crop: { zoom: number; x: number; y: number };
}) {
  return (
    <figure className="page-crop-card">
      <div className="page-crop-frame">
        <img
          src={client.creativeIllustrationUrl(
            familyId,
            page.id,
            page.currentIllustrationVersionId ?? undefined,
          )}
          alt={`قصّ قابل للضبط من رسم صفحة ${page.storyPageIndex}`}
          style={{
            objectPosition: `${crop.x}% ${crop.y}%`,
            transform: `scale(${crop.zoom})`,
          }}
        />
      </div>
      <figcaption>الصفحة الحالية</figcaption>
    </figure>
  );
}

function SheetReference({
  client,
  familyId,
  sheet,
}: {
  client: ApiClient;
  familyId: string;
  sheet: CreativeSheet;
}) {
  const views = [
    ["face", "الوجه"],
    ["threeQuarter", "ثلاثة أرباع"],
    ["mainOutfit", "الملابس"],
  ] as const;
  return (
    <article className="sheet-reference-card">
      <h4>{sheet.characterName}</h4>
      <div>
        {views.map(([view, label]) => (
          <figure key={view}>
            <img
              src={client.creativeSheetViewUrl(familyId, sheet.id, view)}
              alt={`${label} في الورقة المعتمدة لشخصية ${sheet.characterName}`}
            />
            <figcaption>{label}</figcaption>
          </figure>
        ))}
      </div>
    </article>
  );
}

function CropControls({
  crop,
  onCrop,
}: {
  crop: { zoom: number; x: number; y: number };
  onCrop: (value: { zoom: number; x: number; y: number }) => void;
}) {
  return (
    <div className="crop-controls" aria-label="ضبط قصّ صورة الصفحة">
      <Range
        label="التكبير"
        min={1}
        max={2.5}
        step={0.05}
        value={crop.zoom}
        onValue={(zoom) => onCrop({ ...crop, zoom })}
      />
      <Range
        label="الموضع الأفقي"
        min={0}
        max={100}
        step={1}
        value={crop.x}
        onValue={(x) => onCrop({ ...crop, x })}
      />
      <Range
        label="الموضع الرأسي"
        min={0}
        max={100}
        step={1}
        value={crop.y}
        onValue={(y) => onCrop({ ...crop, y })}
      />
    </div>
  );
}

function Range({
  label,
  min,
  max,
  step,
  value,
  onValue,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onValue: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onValue(Number(event.target.value))}
      />
    </label>
  );
}
