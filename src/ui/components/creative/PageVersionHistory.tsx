import type { ApiClient } from "../../api";
import type { CreativePage, CreativePageHistory } from "../../creative-types";

interface PageVersionHistoryProps {
  client: ApiClient;
  familyId: string;
  page: CreativePage;
  history: CreativePageHistory;
  busy: boolean;
  onRevert: (
    page: CreativePage,
    kind: "text" | "illustration",
    targetVersionId: string,
  ) => Promise<void>;
}

export function PageVersionHistory(props: PageVersionHistoryProps) {
  return (
    <details className="version-history">
      <summary>
        سجل النسخ ({props.history.text.length} نص،{" "}
        {props.history.illustrations.length} رسم)
      </summary>
      <div className="version-history__columns">
        <TextVersions {...props} />
        <IllustrationVersions {...props} />
      </div>
    </details>
  );
}

function TextVersions(props: PageVersionHistoryProps) {
  return (
    <section aria-labelledby="text-history-title">
      <h4 id="text-history-title">نسخ النص</h4>
      <ol>
        {[...props.history.text].reverse().map((version) => {
          const current = version.id === props.page.currentTextVersionId;
          return (
            <li key={version.id}>
              <div>
                <strong>
                  {current ? "الحالي" : sourceLabel(version.source)}
                </strong>
                <small>
                  <bdi>{shortId(version.id)}</bdi> ·{" "}
                  {shortDate(version.createdAt)}
                </small>
                <p>{version.narrative}</p>
              </div>
              <button
                className="button button--secondary"
                type="button"
                disabled={props.busy || props.page.locked || current}
                onClick={() =>
                  void props.onRevert(props.page, "text", version.id)
                }
              >
                استعادة هذا النص
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function IllustrationVersions(props: PageVersionHistoryProps) {
  return (
    <section aria-labelledby="image-history-title">
      <h4 id="image-history-title">نسخ الرسم</h4>
      <ol>
        {[...props.history.illustrations].reverse().map((version) => {
          const current =
            version.id === props.page.currentIllustrationVersionId;
          return (
            <li key={version.id} className="illustration-version">
              <img
                src={props.client.creativeIllustrationUrl(
                  props.familyId,
                  props.page.id,
                  version.id,
                )}
                alt={`نسخة رسم ${shortId(version.id)}`}
              />
              <div>
                <strong>{current ? "الرسم الحالي" : "رسم سابق"}</strong>
                <small>
                  <bdi>{shortId(version.id)}</bdi> ·{" "}
                  {shortDate(version.createdAt)}
                </small>
              </div>
              <button
                className="button button--secondary"
                type="button"
                disabled={props.busy || props.page.locked || current}
                onClick={() =>
                  void props.onRevert(props.page, "illustration", version.id)
                }
              >
                استعادة هذا الرسم
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function sourceLabel(source: CreativePageHistory["text"][number]["source"]) {
  if (source === "manual") return "تعديل يدوي";
  return source === "revert" ? "استعادة" : "توليد";
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function shortId(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
