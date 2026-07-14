import { useId, type CSSProperties, type KeyboardEvent } from "react";

import type { SubjectRectangle } from "../../types";

const STEP = 0.01;
const MIN_SIZE = 0.15;

interface SubjectSelectorProps {
  imageUrl: string;
  imageAlt: string;
  value: SubjectRectangle;
  onChange: (value: SubjectRectangle) => void;
  onInteraction: () => void;
}

export function SubjectSelector(props: SubjectSelectorProps) {
  const helpId = useId();
  const style: CSSProperties = {
    insetInlineStart: `${props.value.x * 100}%`,
    insetBlockStart: `${props.value.y * 100}%`,
    width: `${props.value.width * 100}%`,
    height: `${props.value.height * 100}%`,
  };
  return (
    <fieldset className="subject-selector">
      <legend>حدود الشخص المقصود</legend>
      <p id={helpId} className="field-help">
        ركّز الإطار ثم استخدم الأسهم لتحريكه. استخدم Shift مع الأسهم لتغيير
        حجمه. يمكن ضبط النسب بدقة من الحقول التالية.
      </p>
      <div className="subject-stage" dir="ltr">
        <img src={props.imageUrl} alt={props.imageAlt} />
        <button
          type="button"
          className="subject-box"
          style={style}
          aria-label="إطار الشخص المقصود، حرّكه بالأسهم وغيّر حجمه مع Shift"
          aria-describedby={helpId}
          onKeyDown={(event) => handleSubjectKey(event, props)}
        >
          <span aria-hidden="true">الشخص</span>
        </button>
      </div>
      <CoordinateFields
        value={props.value}
        onChange={props.onChange}
        onInteraction={props.onInteraction}
      />
    </fieldset>
  );
}

function handleSubjectKey(
  event: KeyboardEvent<HTMLButtonElement>,
  props: SubjectSelectorProps,
) {
  if (!event.key.startsWith("Arrow")) return;
  event.preventDefault();
  props.onInteraction();
  const delta =
    event.key === "ArrowLeft" || event.key === "ArrowUp" ? -STEP : STEP;
  const axis =
    event.key === "ArrowLeft" || event.key === "ArrowRight" ? "x" : "y";
  props.onChange(
    event.shiftKey
      ? resize(props.value, axis, delta)
      : move(props.value, axis, delta),
  );
}

function move(value: SubjectRectangle, axis: "x" | "y", delta: number) {
  if (axis === "x")
    return { ...value, x: clamp(value.x + delta, 0, 1 - value.width) };
  return { ...value, y: clamp(value.y + delta, 0, 1 - value.height) };
}

function resize(value: SubjectRectangle, axis: "x" | "y", delta: number) {
  if (axis === "x")
    return {
      ...value,
      width: clamp(value.width + delta, MIN_SIZE, 1 - value.x),
    };
  return {
    ...value,
    height: clamp(value.height + delta, MIN_SIZE, 1 - value.y),
  };
}

function CoordinateFields(props: {
  value: SubjectRectangle;
  onChange: (value: SubjectRectangle) => void;
  onInteraction?: () => void;
}) {
  return (
    <div className="coordinate-grid">
      <CoordinateField
        label="بداية أفقية"
        value={props.value.x}
        onChange={(x) => {
          props.onInteraction?.();
          props.onChange(normalize({ ...props.value, x }));
        }}
      />
      <CoordinateField
        label="بداية رأسية"
        value={props.value.y}
        onChange={(y) => {
          props.onInteraction?.();
          props.onChange(normalize({ ...props.value, y }));
        }}
      />
      <CoordinateField
        label="العرض"
        value={props.value.width}
        onChange={(width) => {
          props.onInteraction?.();
          props.onChange(normalize({ ...props.value, width }));
        }}
      />
      <CoordinateField
        label="الارتفاع"
        value={props.value.height}
        onChange={(height) => {
          props.onInteraction?.();
          props.onChange(normalize({ ...props.value, height }));
        }}
      />
    </div>
  );
}

function CoordinateField(props: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}، %</span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={100}
        step={1}
        value={Math.round(props.value * 100)}
        onChange={(event) => {
          const numeric = Number(event.target.value);
          if (Number.isFinite(numeric)) props.onChange(numeric / 100);
        }}
      />
    </label>
  );
}

function normalize(value: SubjectRectangle): SubjectRectangle {
  const width = clamp(value.width, MIN_SIZE, 1);
  const height = clamp(value.height, MIN_SIZE, 1);
  const x = clamp(value.x, 0, 1 - width);
  const y = clamp(value.y, 0, 1 - height);
  return {
    x,
    y,
    width: Math.min(width, 1 - x),
    height: Math.min(height, 1 - y),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
