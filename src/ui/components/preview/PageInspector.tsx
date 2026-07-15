import { useState } from "react";

import type { LayoutPageProjection, LayoutPlacement } from "../../layout-types";
import type { PreviewState } from "../../views/use-preview-state";
import {
  aidLabel,
  pageKindLabel,
  placementLabel,
  placementOptions,
  shortId,
} from "./format";

export function PageInspector({
  page,
  state,
}: {
  page: LayoutPageProjection;
  state: PreviewState;
}) {
  const [placement, setPlacement] = useState<LayoutPlacement>(
    page.layout?.requestedPlacement ?? "auto",
  );
  const [assetId, setAssetId] = useState(
    page.layout?.inputSnapshot.sourceAssets[0]?.assetId ?? "",
  );
  return (
    <section className="preview-panel" aria-labelledby="page-inspector-title">
      <PageHeading page={page} />
      <LayoutFacts page={page} />
      <LayoutWarnings page={page} />
      <PageControls
        page={page}
        state={state}
        placement={placement}
        assetId={assetId}
        onPlacement={setPlacement}
        onAsset={setAssetId}
      />
    </section>
  );
}

function PageHeading({ page }: { page: LayoutPageProjection }) {
  return (
    <div className="preview-section-heading">
      <div>
        <p className="eyebrow">صفحة {page.pageNumber}</p>
        <h2 id="page-inspector-title">{pageKindLabel(page.kind)}</h2>
      </div>
      <span className={`preview-chip preview-chip--${page.staleState}`}>
        {page.staleState === "current" ? "حالية" : "قديمة"}
      </span>
    </div>
  );
}

function LayoutFacts({ page }: { page: LayoutPageProjection }) {
  return (
    <dl className="preview-facts">
      <Fact
        label="الموضع الفعلي"
        value={placementLabel(page.layout?.resolvedPlacement)}
      />
      <Fact
        label="مساعدة القراءة"
        value={aidLabel(page.layout?.readabilityAid)}
      />
      <Fact
        label="حجم الخط"
        value={page.layout ? `${page.layout.fontSizePt} pt` : "—"}
      />
      <Fact label="معرّف التنسيق" value={shortId(page.layout?.id)} bidi />
    </dl>
  );
}

function Fact(props: { label: string; value: string; bidi?: boolean }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.bidi ? <bdi>{props.value}</bdi> : props.value}</dd>
    </div>
  );
}

function LayoutWarnings({ page }: { page: LayoutPageProjection }) {
  if (!page.layout?.warnings.length)
    return <p className="preview-ok">✓ لا توجد تحذيرات تنسيق.</p>;
  return (
    <ul className="preview-warning-list">
      {page.layout.warnings.map((warning) => (
        <li key={warning}>! {warning}</li>
      ))}
    </ul>
  );
}

interface PageControlsProps {
  page: LayoutPageProjection;
  state: PreviewState;
  placement: LayoutPlacement;
  assetId: string;
  onPlacement: (value: LayoutPlacement) => void;
  onAsset: (value: string) => void;
}

function PageControls(props: PageControlsProps) {
  const story = props.page.kind === "story";
  const assetRequired = !story && props.page.kind !== "dedication";
  return (
    <>
      <div className="preview-control-grid">
        <PlacementField value={props.placement} onChange={props.onPlacement} />
        {!story ? <AssetField {...props} /> : null}
      </div>
      <button
        className="button button--primary"
        type="button"
        disabled={
          props.state.busy ||
          (story && props.page.locked) ||
          (assetRequired && !props.assetId)
        }
        onClick={() => void submitPageControls(props, story)}
      >
        {story ? "إنشاء تنسيق لاحق" : "حفظ اختيار الرسم"}
      </button>
      {story && props.page.locked ? (
        <p className="preview-help">
          افتح الصفحة أولًا من شاشة الإبداع والمراجعة.
        </p>
      ) : null}
    </>
  );
}

function PlacementField(props: {
  value: LayoutPlacement;
  onChange: (value: LayoutPlacement) => void;
}) {
  return (
    <label className="field">
      <span>موضع النص المطلوب</span>
      <select
        value={props.value}
        onChange={(event) =>
          props.onChange(event.target.value as LayoutPlacement)
        }
      >
        {placementOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function AssetField(props: PageControlsProps) {
  return (
    <label className="field">
      <span>الرسم المعتمد</span>
      <select
        value={props.assetId}
        onChange={(event) => props.onAsset(event.target.value)}
      >
        {props.page.kind === "dedication" ? (
          <option value="">بلا رسم</option>
        ) : null}
        {props.state.snapshot!.eligibleCompositionAssets.map((asset) => (
          <option key={asset.assetId} value={asset.assetId}>
            أصل {shortId(asset.assetId)}
          </option>
        ))}
      </select>
    </label>
  );
}

function submitPageControls(props: PageControlsProps, story: boolean) {
  if (story) return props.state.recalculate(props.page, props.placement);
  return props.state.changeSource(
    props.page,
    props.assetId || null,
    props.placement,
  );
}
