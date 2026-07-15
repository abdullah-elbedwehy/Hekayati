import { useState } from "react";

import type { PreviewState } from "../../views/use-preview-state";
import { shortId } from "./format";

export function CoverEditor({ state }: { state: PreviewState }) {
  const cover = state.snapshot!.cover!;
  const [frontAssetId, setFrontAssetId] = useState(
    cover.front.artworkAssetId ?? "",
  );
  const [environmentLine, setEnvironmentLine] = useState(
    cover.front.environmentLine ?? "",
  );
  const [synopsis, setSynopsis] = useState(cover.back.synopsis ?? "");
  return (
    <section className="preview-panel" aria-labelledby="cover-editor-title">
      <CoverHeading source={cover.selectionSource} />
      <div className="preview-cover-proof" aria-label="نص الغلاف الحالي">
        <strong>{cover.front.title}</strong>
        <span>{cover.front.childDisplayName}</span>
        <small>{cover.back.brandLine}</small>
      </div>
      <CoverFields
        state={state}
        frontAssetId={frontAssetId}
        environmentLine={environmentLine}
        synopsis={synopsis}
        onAsset={setFrontAssetId}
        onEnvironment={setEnvironmentLine}
        onSynopsis={setSynopsis}
      />
      <button
        className="button button--secondary"
        type="button"
        disabled={state.busy || !frontAssetId}
        onClick={() =>
          void state.changeCover(frontAssetId, environmentLine, synopsis)
        }
      >
        إنشاء نسخة غلاف لاحقة
      </button>
    </section>
  );
}

function CoverHeading({ source }: { source: "automatic_v1" | "operator" }) {
  return (
    <div className="preview-section-heading">
      <div>
        <p className="eyebrow">الوجهان خارج الداخل</p>
        <h2 id="cover-editor-title">تركيب الغلاف</h2>
      </div>
      <span>{source === "operator" ? "اختيار يدوي" : "اختيار آلي"}</span>
    </div>
  );
}

interface CoverFieldsProps {
  state: PreviewState;
  frontAssetId: string;
  environmentLine: string;
  synopsis: string;
  onAsset: (value: string) => void;
  onEnvironment: (value: string) => void;
  onSynopsis: (value: string) => void;
}

function CoverFields(props: CoverFieldsProps) {
  return (
    <div className="preview-control-grid">
      <label className="field">
        <span>رسم الوجه الأمامي</span>
        <select
          value={props.frontAssetId}
          onChange={(event) => props.onAsset(event.target.value)}
        >
          <option value="">اختر أصلًا معتمدًا</option>
          {props.state.snapshot!.eligibleCompositionAssets.map((asset) => (
            <option key={asset.assetId} value={asset.assetId}>
              أصل {shortId(asset.assetId)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>سطر البيئة — اختياري</span>
        <input
          value={props.environmentLine}
          maxLength={1000}
          onChange={(event) => props.onEnvironment(event.target.value)}
        />
      </label>
      <label className="field preview-field-wide">
        <span>ملخص الوجه الخلفي — اختياري</span>
        <textarea
          value={props.synopsis}
          maxLength={4000}
          rows={3}
          onChange={(event) => props.onSynopsis(event.target.value)}
        />
      </label>
    </div>
  );
}
