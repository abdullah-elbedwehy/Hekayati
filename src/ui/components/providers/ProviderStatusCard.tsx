import type { ProviderId, ProviderProjection } from "../../types";

const labels: Record<ProviderId, string> = {
  mock: "المزوّد التجريبي",
  codex: "Codex",
  gemini: "Gemini",
};

export function ProviderStatusCard(props: {
  providerId: ProviderId;
  projection: ProviderProjection;
  busy: boolean;
  onTest: () => Promise<void>;
}) {
  const state = statePresentation(props.projection.state);
  return (
    <article
      className="provider-card"
      aria-labelledby={`${props.providerId}-title`}
    >
      <header className="provider-card__header">
        <div>
          <p className="eyebrow">
            {state.icon} {state.label}
          </p>
          <h3 id={`${props.providerId}-title`}>{labels[props.providerId]}</h3>
        </div>
        <button
          className="button button--secondary"
          type="button"
          disabled={props.busy}
          onClick={() => void props.onTest()}
        >
          {props.busy ? "جارٍ الفحص…" : "اختبار الاتصال"}
        </button>
      </header>
      <ProviderOperation label="النص" operation={props.projection.text} />
      <ProviderOperation label="الصور" operation={props.projection.image} />
      {props.providerId === "codex" && (
        <p className="provider-warning" role="note">
          ⓘ G1-I: إنشاء الصور عبر اشتراك Codex غير متاح حاليًا.
        </p>
      )}
      <ProviderCheckMeta projection={props.projection} />
    </article>
  );
}

function ProviderOperation(props: {
  label: string;
  operation: ProviderProjection["text"] | ProviderProjection["image"];
}) {
  if (!props.operation) {
    return (
      <div className="provider-operation">
        <span>{props.label}</span>
        <strong>لم يُفحص</strong>
      </div>
    );
  }
  return (
    <div className="provider-operation">
      <span>{props.label}</span>
      <strong>{props.operation.available ? "✓ متاح" : "× غير متاح"}</strong>
      {props.operation.modelId && <bdi>{props.operation.modelId}</bdi>}
      {props.operation.unavailableReason && (
        <small>{props.operation.unavailableReason}</small>
      )}
    </div>
  );
}

function ProviderCheckMeta({ projection }: { projection: ProviderProjection }) {
  if (!projection.checkedAt) return null;
  return (
    <p className="provider-card__meta">
      آخر فحص:{" "}
      <time dateTime={projection.checkedAt}>
        {formatDate(projection.checkedAt)}
      </time>
      {projection.source && <> · {sourceLabel(projection.source)}</>}
    </p>
  );
}

function statePresentation(state: ProviderProjection["state"]) {
  if (state === "available") return { icon: "✓", label: "متاح" };
  if (state === "unavailable") return { icon: "×", label: "غير متاح" };
  return { icon: "○", label: "لم يُفحص" };
}

function sourceLabel(
  source: NonNullable<ProviderProjection["source"]>,
): string {
  if (source === "cache") return "نتيجة محفوظة مؤقتًا";
  if (source === "fixture") return "محلي تجريبي";
  return "فحص مباشر";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ar-EG-u-nu-latn", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
