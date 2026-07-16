import type { PrintProfileDraft } from "../../print-types";
import type { PrintState } from "../../views/use-print-state";
import { blankCount, withBlanks } from "./print-profile-model";
import type { PrintProfileEditor } from "./use-profile-editor";

export function ProfileSelection({
  state,
  editor,
}: {
  state: PrintState;
  editor: PrintProfileEditor;
}) {
  return (
    <>
      <label className="field print-field--wide">
        <span>تحرير ملف محفوظ</span>
        <select
          value={editor.editingId}
          onChange={(event) => editor.select(event.target.value)}
        >
          <option value="">ملف جديد</option>
          {state.profiles
            .filter((item) => !item.profile.archived)
            .map((item) => (
              <option value={item.profile.id} key={item.profile.id}>
                {item.profile.name} —{" "}
                {item.version.readiness === "ready" ? "جاهز" : "ناقص"}
              </option>
            ))}
        </select>
      </label>
      <label className="field print-field--wide">
        <span>اسم الملف</span>
        <input
          value={editor.name}
          maxLength={160}
          onChange={(event) => editor.setName(event.target.value)}
        />
      </label>
    </>
  );
}

export function ProfileGeometry({ editor }: { editor: PrintProfileEditor }) {
  const { draft, setDraft } = editor;
  return (
    <>
      <NumberField
        label="عرض القص (مم)"
        value={draft.trim.widthMm}
        onChange={(widthMm) =>
          setDraft({ ...draft, trim: { ...draft.trim, widthMm } })
        }
      />
      <NumberField
        label="ارتفاع القص (مم)"
        value={draft.trim.heightMm}
        onChange={(heightMm) =>
          setDraft({ ...draft, trim: { ...draft.trim, heightMm } })
        }
      />
      <NumberField
        label="النزف (مم)"
        value={draft.bleedMm}
        onChange={(bleedMm) => setDraft({ ...draft, bleedMm })}
      />
      <NumberField
        label="أقل دقة فعلية"
        value={draft.dpiMin}
        step={1}
        onChange={(dpiMin) => setDraft({ ...draft, dpiMin })}
      />
      <SpineField editor={editor} />
      <ColorModeField editor={editor} />
    </>
  );
}

function SpineField({ editor }: { editor: PrintProfileEditor }) {
  const { draft, setDraft } = editor;
  return (
    <NumberField
      label="عرض الكعب (مم)"
      value={draft.spine.widthMm ?? 0}
      onChange={(widthMm) =>
        setDraft({
          ...draft,
          spine:
            widthMm > 0
              ? {
                  source: draft.coverTemplate ? "template" : "explicit",
                  widthMm,
                }
              : { source: "missing", widthMm: null },
        })
      }
    />
  );
}

function ColorModeField({ editor }: { editor: PrintProfileEditor }) {
  const { draft, setDraft } = editor;
  return (
    <label className="field">
      <span>مسار اللون</span>
      <select
        value={draft.color.mode}
        onChange={(event) =>
          setColorMode(event.target.value as "rgb" | "cmyk", draft, setDraft)
        }
      >
        <option value="rgb">RGB مباشر</option>
        <option value="cmyk">CMYK مع بروفة</option>
      </select>
    </label>
  );
}

export function ProfileMechanics({ editor }: { editor: PrintProfileEditor }) {
  return (
    <details className="print-mechanics">
      <summary>الهوامش والعلامات والصفحات الفنية</summary>
      <div className="print-form-grid">
        <SafeRegionFields editor={editor} />
        <CropMarksField editor={editor} />
        <BlankPageFields editor={editor} />
      </div>
    </details>
  );
}

function SafeRegionFields({ editor }: { editor: PrintProfileEditor }) {
  const region = editor.draft.safeContentRegion;
  const update = (value: Partial<typeof region>) =>
    editor.setDraft({
      ...editor.draft,
      safeContentRegion: { ...region, ...value },
    });
  return (
    <>
      <NumberField
        label="بداية الأمان أفقيًا"
        value={region.x}
        step={0.01}
        onChange={(x) => update({ x })}
      />
      <NumberField
        label="بداية الأمان رأسيًا"
        value={region.y}
        step={0.01}
        onChange={(y) => update({ y })}
      />
      <NumberField
        label="عرض منطقة الأمان"
        value={region.width}
        step={0.01}
        onChange={(width) => update({ width })}
      />
      <NumberField
        label="ارتفاع منطقة الأمان"
        value={region.height}
        step={0.01}
        onChange={(height) => update({ height })}
      />
    </>
  );
}

function CropMarksField({ editor }: { editor: PrintProfileEditor }) {
  const { draft, setDraft } = editor;
  return (
    <label className="print-check">
      <input
        type="checkbox"
        checked={draft.cropMarks.enabled}
        onChange={(event) =>
          setDraft({
            ...draft,
            cropMarks: event.target.checked
              ? { enabled: true, offsetMm: 2, lengthMm: 5, strokePt: 0.25 }
              : { enabled: false, offsetMm: 0, lengthMm: 0, strokePt: 0.25 },
          })
        }
      />
      <span>إضافة علامات قص خارج النزف</span>
    </label>
  );
}

function BlankPageFields({ editor }: { editor: PrintProfileEditor }) {
  const change = (
    position: "before_interior" | "after_interior",
    raw: number,
  ) => editor.setDraft(withBlanks(editor.draft, position, raw));
  return (
    <>
      <NumberField
        label="صفحات فنية قبل الداخل"
        value={blankCount(editor.draft, "before_interior")}
        step={1}
        onChange={(value) => change("before_interior", value)}
      />
      <NumberField
        label="صفحات فنية بعد الداخل"
        value={blankCount(editor.draft, "after_interior")}
        step={1}
        onChange={(value) => change("after_interior", value)}
      />
    </>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  step?: number;
  onChange(value: number): void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        dir="ltr"
        value={props.value}
        step={props.step ?? 0.1}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

function setColorMode(
  mode: "rgb" | "cmyk",
  draft: PrintProfileDraft,
  setDraft: (draft: PrintProfileDraft) => void,
): void {
  if (mode === "rgb") setDraft({ ...draft, color: { mode: "rgb" } });
  else if (draft.color.mode !== "cmyk")
    setDraft({
      ...draft,
      color: { mode: "cmyk", iccAssetId: "", iccChecksum: "" },
    });
}
