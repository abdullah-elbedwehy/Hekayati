import type { PrintState } from "../../views/use-print-state";
import { coverRegions } from "./print-profile-model";
import type { PrintProfileEditor } from "./use-profile-editor";

export function ProfileAssets({
  state,
  editor,
}: {
  state: PrintState;
  editor: PrintProfileEditor;
}) {
  return (
    <>
      {editor.draft.color.mode === "cmyk" ? (
        <UploadRow
          label="ملف ICC رباعي القنوات"
          state={editor.iccState}
          accept=".icc,application/vnd.iccprofile"
          disabled={state.busy}
          onFile={(file) => importIcc(file, state, editor)}
        />
      ) : null}
      <UploadRow
        label="قالب غلاف PDF اختياري"
        state={editor.templateState}
        accept=".pdf,application/pdf"
        disabled={state.busy || !editor.draft.spine.widthMm}
        onFile={(file) => importTemplate(file, state, editor)}
      />
    </>
  );
}

async function importIcc(
  file: File,
  state: PrintState,
  editor: PrintProfileEditor,
): Promise<void> {
  editor.setIccState("جارٍ الفحص المحلي…");
  try {
    const imported = await state.importIcc(file);
    editor.setDraft({
      ...editor.draft,
      color: {
        mode: "cmyk",
        iccAssetId: imported.asset.id,
        iccChecksum: imported.asset.sha256,
      },
    });
    editor.setIccState(`CMYK صالح — ${imported.facts.channels} قنوات`);
  } catch {
    editor.setIccState("رُفض الملف: ليس ICC رباعي القنوات صالحًا");
  }
}

async function importTemplate(
  file: File,
  state: PrintState,
  editor: PrintProfileEditor,
): Promise<void> {
  editor.setTemplateState("جارٍ فحص القالب المحلي…");
  try {
    const imported = await state.importTemplate(
      file,
      coverRegions(editor.draft),
    );
    const widthMm = editor.draft.spine.widthMm;
    if (!widthMm) throw new Error("PRINT_SPINE_REQUIRED");
    editor.setDraft({
      ...editor.draft,
      coverTemplate: imported.facts,
      spine: { source: "template", widthMm },
    });
    editor.setTemplateState("قالب صفحة واحدة صالح ومطابق للهندسة");
  } catch {
    editor.setTemplateState("رُفض القالب: راجع الصفحة والأفعال والهندسة");
  }
}

function UploadRow(props: {
  label: string;
  state: string;
  accept: string;
  disabled: boolean;
  onFile(file: File): Promise<void>;
}) {
  return (
    <div className="print-upload">
      <label className="button button--secondary">
        <span>{props.label}</span>
        <input
          className="visually-hidden"
          type="file"
          accept={props.accept}
          disabled={props.disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void props.onFile(file);
            event.target.value = "";
          }}
        />
      </label>
      <span role="status">{props.state}</span>
    </div>
  );
}
