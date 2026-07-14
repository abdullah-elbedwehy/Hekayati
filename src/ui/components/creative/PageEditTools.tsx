import { useState } from "react";

import type { CreativePage, CreativePageHistory } from "../../creative-types";

interface PageEditToolsProps {
  page: CreativePage;
  history: CreativePageHistory;
  busy: boolean;
  onRewriteText: (
    page: CreativePage,
    narrative: string,
    dialogue: Array<{ speakerCharacterId: string; text: string }>,
  ) => Promise<void>;
  onRequestLayout: (page: CreativePage) => Promise<void>;
}

export function PageEditTools(props: PageEditToolsProps) {
  const current = props.history.text.find(
    (item) => item.id === props.page.currentTextVersionId,
  );
  return <PageEditForm key={current?.id} {...props} current={current} />;
}

function PageEditForm({
  page,
  busy,
  current,
  onRewriteText,
  onRequestLayout,
}: PageEditToolsProps & {
  current: CreativePageHistory["text"][number] | undefined;
}) {
  const [draft, setDraft] = useState(current?.narrative ?? "");
  return (
    <details className="page-edit-tools">
      <summary>تعديل النص أو طلب إعادة التخطيط</summary>
      <label className="field">
        <span>نص الصفحة</span>
        <textarea
          rows={6}
          value={draft}
          disabled={page.locked}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="page-edit-actions">
        <button
          className="button button--primary"
          type="button"
          disabled={
            busy || page.locked || !draft.trim() || draft === current?.narrative
          }
          onClick={() =>
            void onRewriteText(page, draft.trim(), current?.dialogue ?? [])
          }
        >
          حفظ نسخة نص جديدة
        </button>
        <button
          className="button button--secondary"
          type="button"
          disabled={busy || page.locked}
          onClick={() => void onRequestLayout(page)}
        >
          إعادة حساب التخطيط فقط
        </button>
      </div>
      <p>إعادة التخطيط تُرسل طلبًا إلى مرحلة 008 ولا تغيّر الرسم أو النص.</p>
    </details>
  );
}
