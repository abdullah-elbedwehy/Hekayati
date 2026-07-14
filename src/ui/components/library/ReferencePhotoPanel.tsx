import type {
  LibraryReferencePhoto,
  PhotoObservations,
  PhotoWarning,
} from "../../types";
import { InlineNotice } from "./LibraryPrimitives";
import { formatLibraryDate, warningLabel } from "./library-utils";

export function ReferencePhotoPanel(props: {
  photos: LibraryReferencePhoto[];
  subjectName: string;
}) {
  if (props.photos.length === 0) return null;
  return (
    <section className="reference-panel" aria-label="مراجعة المراجع المحفوظة">
      <div className="library-subheading">
        <div>
          <p className="eyebrow">مشتقات آمنة وملاحظات محفوظة</p>
          <h4>مراجعة المراجع</h4>
        </div>
        <span className="plain-badge">{props.photos.length} مرجع</span>
      </div>
      <div className="reference-grid">
        {props.photos.map((photo) => (
          <ReferenceCard
            key={photo.id}
            photo={photo}
            subjectName={props.subjectName}
          />
        ))}
      </div>
    </section>
  );
}

function ReferenceCard(props: {
  photo: LibraryReferencePhoto;
  subjectName: string;
}) {
  const photo = props.photo;
  return (
    <article className="reference-card">
      <img
        src={photo.thumbnailUrl}
        alt={`صورة مصغرة مشتقة محفوظة لـ ${props.subjectName}`}
      />
      <div className="reference-card__body">
        <div className="reference-card__meta">
          <strong>{kindLabel(photo.kind)}</strong>
          <bdi>
            {photo.widthPx} × {photo.heightPx}
          </bdi>
          <time dateTime={photo.createdAt}>
            {formatLibraryDate(photo.createdAt)}
          </time>
        </div>
        <PhotoWarningReview warnings={photo.quality.warnings} />
        <ObservationReview observations={photo.quality.observations} />
        <small className="policy-label">
          سياسة الفحص: <bdi>{photo.quality.policyVersion}</bdi>
        </small>
      </div>
    </article>
  );
}

function PhotoWarningReview({ warnings }: { warnings: PhotoWarning[] }) {
  if (warnings.length === 0)
    return (
      <InlineNotice tone="success">
        لم تُحفظ ملاحظات جودة لهذا المرجع.
      </InlineNotice>
    );
  return (
    <ul className="warning-list warning-list--compact">
      {warnings.map((warning, index) => (
        <li key={`${warning.code}-${index}`}>
          <strong>{warningLabel(warning.code)}</strong>
          <small>{warningEvidence(warning)}</small>
        </li>
      ))}
    </ul>
  );
}

function ObservationReview({
  observations,
}: {
  observations: PhotoObservations;
}) {
  const entries = observationEntries(observations);
  if (entries.length === 0) return null;
  return (
    <details className="reference-observations">
      <summary>الملاحظات البشرية المحفوظة</summary>
      <dl>
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function observationEntries(value: PhotoObservations): Array<[string, string]> {
  return [
    value.peopleCount === undefined
      ? null
      : ["عدد الأشخاص", String(value.peopleCount)],
    value.obstruction ? ["الحجب", value.obstruction] : null,
    value.filterSuspected === undefined
      ? null
      : ["مرشح ثقيل", value.filterSuspected ? "مشتبه به" : "غير مشتبه به"],
    value.apparentAgeBand
      ? ["الفئة العمرية الوصفية", value.apparentAgeBand]
      : null,
    value.hair ? ["الشعر", value.hair] : null,
    value.clothing ? ["الملابس", value.clothing] : null,
  ].filter((entry): entry is [string, string] => entry !== null);
}

function warningEvidence(warning: PhotoWarning): string {
  if (warning.source === "operator") return "ملاحظة بشرية مسجّلة";
  const threshold = warning.threshold ?? "—";
  return `فحص محلي، ${warning.metric ?? "مقياس مسجّل"}، الحد ${threshold}`;
}

function kindLabel(kind: LibraryReferencePhoto["kind"]): string {
  if (kind === "face") return "مرجع وجه";
  if (kind === "full_body") return "مرجع جسم كامل";
  if (kind === "clothing") return "مرجع ملابس";
  return "مرجع إضافي";
}
