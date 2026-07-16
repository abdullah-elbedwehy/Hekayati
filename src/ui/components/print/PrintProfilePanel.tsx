import type { PrinterProfileProjection } from "../../print-types";
import type { PrintState } from "../../views/use-print-state";
import { ProfileAssets } from "./PrintProfileAssets";
import {
  ProfileGeometry,
  ProfileMechanics,
  ProfileSelection,
} from "./PrintProfileFields";
import { canSave } from "./print-profile-model";
import {
  useProfileEditor,
  type PrintProfileEditor,
} from "./use-profile-editor";

export function PrintProfilePanel({ state }: { state: PrintState }) {
  const editor = useProfileEditor(state);
  return (
    <section
      className="print-card print-profile-panel"
      aria-labelledby="profile-title"
    >
      <header className="print-card-heading">
        <div>
          <p className="eyebrow">حقيقة الطابعة</p>
          <h2 id="profile-title">ملف الطابعة</h2>
        </div>
        <ProfileReadiness profile={editor.editing} />
      </header>
      <p className="print-progress">
        اكتمال الملف يعني اكتمال البيانات المحلية فقط. مواصفات المطبعة الفعلية
        والبروفة الورقية بوابتان يدويتان قبل أي طلب تجاري.
      </p>
      <div className="print-form-grid">
        <ProfileSelection state={state} editor={editor} />
        <ProfileGeometry editor={editor} />
      </div>
      <ProfileMechanics editor={editor} />
      <ProfileAssets state={state} editor={editor} />
      <ProfileActions state={state} editor={editor} />
    </section>
  );
}

function ProfileActions({
  state,
  editor,
}: {
  state: PrintState;
  editor: PrintProfileEditor;
}) {
  const editing = editor.editing;
  return (
    <div className="print-actions">
      <button
        className="button button--primary"
        disabled={state.busy || !canSave(editor.name, editor.draft)}
        onClick={() =>
          void state.saveProfile(
            editor.name.trim(),
            editor.draft,
            editor.editing,
          )
        }
      >
        {editing ? "حفظ نسخة جديدة" : "إنشاء ملف الطابعة"}
      </button>
      {editing && state.snapshot ? (
        <button
          className="button button--secondary"
          disabled={state.busy || editing.version.readiness !== "ready"}
          onClick={() => void state.assignProfile(editing)}
        >
          ربطه بالمشروع المختار
        </button>
      ) : null}
      <button
        className="button button--quiet"
        type="button"
        onClick={editor.reset}
      >
        ملف جديد
      </button>
    </div>
  );
}

function ProfileReadiness({
  profile,
}: {
  profile: PrinterProfileProjection | null;
}) {
  if (!profile)
    return <span className="print-state print-state--neutral">جديد</span>;
  const ready = profile.version.readiness === "ready";
  return (
    <span
      className={`print-state ${ready ? "print-state--ok" : "print-state--warn"}`}
    >
      {ready ? "✓ مكتمل محليًا" : "! بيانات ناقصة"}
    </span>
  );
}
