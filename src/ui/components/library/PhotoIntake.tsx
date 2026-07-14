import { useId, useState, type FormEvent } from "react";

import type { ApiClient, PhotoCommitResult, PhotoStageInput } from "../../api";
import type {
  PhotoIntakeReservation,
  PhotoObservations,
  SubjectRectangle,
} from "../../types";
import { EditorActions, FormMessage, InlineNotice } from "./LibraryPrimitives";
import { libraryError, relationshipLabel, warningLabel } from "./library-utils";
import { SubjectSelector } from "./SubjectSelector";

type Owner = PhotoStageInput["owner"];
type SaveState = "idle" | "saving" | "saved" | "error";
type PhotoDuplicateChoice = string | null;

interface PhotoIntakeProps {
  client: ApiClient;
  familyId: string;
  owner: Owner;
  subjectName: string;
  onComplete: (result: PhotoCommitResult) => Promise<void>;
  onCancel: () => void;
}

export function PhotoIntake(props: PhotoIntakeProps) {
  const [reservation, setReservation] = useState<PhotoIntakeReservation | null>(
    null,
  );
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  async function stage(input: Omit<PhotoStageInput, "familyId" | "owner">) {
    setState("saving");
    setError("");
    try {
      setReservation(
        await props.client.stagePhoto({
          ...input,
          familyId: props.familyId,
          owner: props.owner,
        }),
      );
      setState("idle");
    } catch (reason) {
      setError(libraryError(reason));
      setState("error");
    }
  }
  if (!reservation)
    return (
      <StagePhotoForm
        subjectName={props.subjectName}
        state={state}
        error={error}
        onStage={stage}
        onCancel={props.onCancel}
      />
    );
  return (
    <StagedPhoto
      {...props}
      reservation={reservation}
      state={state}
      error={error}
      setState={setState}
      setError={setError}
      clearReservation={() => setReservation(null)}
    />
  );
}

function StagePhotoForm(props: {
  subjectName: string;
  state: SaveState;
  error: string;
  onStage: (
    input: Omit<PhotoStageInput, "familyId" | "owner">,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<PhotoStageInput["kind"]>("face");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (file) void props.onStage({ file, kind });
  }
  return (
    <form className="photo-intake" onSubmit={submit}>
      <PhotoChecklist />
      <InlineNotice tone="info">
        تُفحص الصورة محليًا. تبقى النسخة الأصلية في مساحة خاصة، ولا تعرض هذه
        الواجهة إلا صورة مصغرة مشتقة ونظيفة.
      </InlineNotice>
      <PhotoStageFields
        subjectName={props.subjectName}
        kind={kind}
        setKind={setKind}
        setFile={setFile}
      />
      <EditorActions
        state={props.state}
        error={props.error}
        primaryLabel="فحص الصورة محليًا"
        primaryDisabled={!file}
        onCancel={props.onCancel}
      />
    </form>
  );
}

function PhotoStageFields(props: {
  subjectName: string;
  kind: PhotoStageInput["kind"];
  setKind: (kind: PhotoStageInput["kind"]) => void;
  setFile: (file: File | null) => void;
}) {
  return (
    <div className="form-grid">
      <label className="field">
        <span>ملف مرجع لـ {props.subjectName}</span>
        <input
          type="file"
          dir="ltr"
          required
          accept=".heic,.heif,.jpg,.jpeg,.png,image/heic,image/heif,image/jpeg,image/png"
          onChange={(event) => props.setFile(event.target.files?.[0] ?? null)}
        />
      </label>
      <label className="field">
        <span>نوع المرجع</span>
        <select
          value={props.kind}
          onChange={(event) =>
            props.setKind(event.target.value as PhotoStageInput["kind"])
          }
        >
          <option value="face">وجه</option>
          <option value="full_body">جسم كامل</option>
          <option value="clothing">ملابس</option>
          <option value="other">مرجع آخر</option>
        </select>
      </label>
    </div>
  );
}

function PhotoChecklist() {
  const headingId = useId();
  return (
    <section className="intake-checklist" aria-labelledby={headingId}>
      <h4 id={headingId}>مراجع موصى بها</h4>
      <ul>
        <li>وجه أمامي واضح</li>
        <li>زاوية ثلاثة أرباع</li>
        <li>صورة جسم كامل</li>
        <li>مرجع للملابس</li>
        <li>إضاءة جيدة بلا مرشحات ثقيلة</li>
      </ul>
    </section>
  );
}

interface StagedPhotoProps extends PhotoIntakeProps {
  reservation: PhotoIntakeReservation;
  state: SaveState;
  error: string;
  setState: (state: SaveState) => void;
  setError: (error: string) => void;
  clearReservation: () => void;
}

function StagedPhoto(props: StagedPhotoProps) {
  const form = useStagedPhoto(props);
  return (
    <div className="photo-intake photo-intake--staged">
      <PhotoFindings reservation={props.reservation} />
      <StagedPreview
        {...props}
        box={form.box}
        setBox={form.setBox}
        selectionRequired={form.selectionRequired}
        onBoxInteraction={() => form.setBoxInteracted(true)}
      />
      <ObservationFields
        value={form.observations}
        onChange={form.setObservations}
      />
      <PersonConfirmation
        multiple={form.multiple}
        confirmed={form.confirmed}
        setConfirmed={form.setConfirmed}
      />
      <DuplicateChoice
        reservation={props.reservation}
        value={form.duplicateId}
        onChange={form.setDuplicateId}
      />
      <IntakeRequirements
        peopleCountKnown={form.peopleCountKnown}
        selectionReady={form.selectionReady}
        duplicateChosen={form.duplicateChosen}
        multipleReady={!form.multiple || form.confirmed}
      />
      <PhotoCommitActions
        {...props}
        canCommit={form.canCommit}
        onCommit={form.commit}
      />
    </div>
  );
}

function useStagedPhoto(props: StagedPhotoProps) {
  const [box, setBox] = useState<SubjectRectangle>({
    x: 0.25,
    y: 0.15,
    width: 0.5,
    height: 0.65,
  });
  const [observations, setObservations] = useState<PhotoObservations>({
    peopleCount: props.reservation.peopleCount,
  });
  const [confirmed, setConfirmed] = useState(false);
  const [boxInteracted, setBoxInteracted] = useState(false);
  const [duplicateId, setDuplicateId] = useState<PhotoDuplicateChoice>(null);
  const readiness = photoReadiness(
    props.reservation,
    observations,
    boxInteracted,
    duplicateId,
    confirmed,
  );
  const commit = () =>
    commitStagedPhoto(props, {
      box,
      observations,
      confirmed,
      duplicateId,
      multiple: readiness.multiple,
      selectionRequired: readiness.selectionRequired,
    });
  return {
    box,
    setBox,
    setBoxInteracted,
    observations,
    setObservations,
    confirmed,
    setConfirmed,
    duplicateId,
    setDuplicateId,
    ...readiness,
    commit,
  };
}

function photoReadiness(
  reservation: PhotoIntakeReservation,
  observations: PhotoObservations,
  boxInteracted: boolean,
  duplicateId: PhotoDuplicateChoice,
  confirmed: boolean,
) {
  const peopleCountKnown =
    Number.isInteger(observations.peopleCount) &&
    (observations.peopleCount ?? 0) >= 1 &&
    (observations.peopleCount ?? 0) <= 20;
  const multiple =
    (observations.peopleCount ?? 0) > 1 ||
    reservation.warnings.some(
      (warning) => warning.code === "PHOTO_MULTIPLE_PEOPLE",
    );
  const selectionRequired = reservation.kind === "face" || multiple;
  const selectionReady = !selectionRequired || boxInteracted;
  const duplicateChosen =
    reservation.duplicateCandidates.length === 0 || duplicateId !== null;
  const canCommit =
    peopleCountKnown &&
    selectionReady &&
    duplicateChosen &&
    (!multiple || confirmed);
  return {
    multiple,
    peopleCountKnown,
    selectionRequired,
    selectionReady,
    duplicateChosen,
    canCommit,
  };
}

async function commitStagedPhoto(
  props: StagedPhotoProps,
  draft: {
    box: SubjectRectangle;
    observations: PhotoObservations;
    confirmed: boolean;
    duplicateId: PhotoDuplicateChoice;
    multiple: boolean;
    selectionRequired: boolean;
  },
) {
  props.setState("saving");
  props.setError("");
  try {
    const result = await props.client.commitPhoto({
      reservationToken: props.reservation.reservationToken,
      subjectSelection: draft.selectionRequired ? draft.box : undefined,
      subjectSelectionConfirmed: draft.selectionRequired ? true : undefined,
      intendedPersonConfirmed: draft.multiple ? draft.confirmed : undefined,
      observations: draft.observations,
      duplicateDecision:
        draft.duplicateId && draft.duplicateId !== "create_separate"
          ? { action: "open_existing", characterId: draft.duplicateId }
          : { action: "create_separate" },
    });
    props.clearReservation();
    await props.onComplete(result);
  } catch (reason) {
    props.setError(libraryError(reason));
    props.setState("error");
  }
}

function StagedPreview(
  props: StagedPhotoProps & {
    box: SubjectRectangle;
    setBox: (box: SubjectRectangle) => void;
    onBoxInteraction: () => void;
    selectionRequired: boolean;
  },
) {
  if (props.selectionRequired)
    return (
      <SubjectSelector
        imageUrl={props.reservation.thumbnailUrl}
        imageAlt={`صورة مصغرة مشتقة لاختيار ${props.subjectName}`}
        value={props.box}
        onChange={props.setBox}
        onInteraction={props.onBoxInteraction}
      />
    );
  return (
    <img
      className="safe-thumbnail"
      src={props.reservation.thumbnailUrl}
      alt={`صورة مصغرة مشتقة لمرجع ${props.subjectName}`}
    />
  );
}

function PersonConfirmation(props: {
  multiple: boolean;
  confirmed: boolean;
  setConfirmed: (value: boolean) => void;
}) {
  if (!props.multiple) return null;
  return (
    <label className="confirmation-check">
      <input
        type="checkbox"
        checked={props.confirmed}
        onChange={(event) => props.setConfirmed(event.target.checked)}
      />{" "}
      وضعت الإطار حول الشخص المقصود تحديدًا
    </label>
  );
}

function PhotoFindings({
  reservation,
}: {
  reservation: PhotoIntakeReservation;
}) {
  const headingId = useId();
  return (
    <section className="photo-findings" aria-labelledby={headingId}>
      <div className="library-subheading">
        <div>
          <p className="eyebrow">فحص محلي غير حيوي</p>
          <h4 id={headingId}>نتيجة الصورة</h4>
        </div>
        <span className="plain-badge">
          <bdi>
            {reservation.widthPx} × {reservation.heightPx}
          </bdi>
        </span>
      </div>
      {reservation.warnings.length === 0 ? (
        <InlineNotice tone="success">
          لم تظهر ملاحظات آلية في السياسة الحالية.
        </InlineNotice>
      ) : (
        <ul className="warning-list">
          {reservation.warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`}>
              <strong>{warningLabel(warning.code)}</strong>
              <small>
                {warning.source === "local_check"
                  ? "فحص محلي"
                  : "ملاحظة الموظف"}
                {warning.metric ? `، ${warning.metric}` : ""}
                {warning.threshold !== undefined
                  ? `، الحد ${warning.threshold}`
                  : ""}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ObservationFields(props: {
  value: PhotoObservations;
  onChange: (value: PhotoObservations) => void;
}) {
  return (
    <details className="profile-details" open>
      <summary>ملاحظات بشرية عن الصورة</summary>
      <ObservationGrid {...props} />
    </details>
  );
}

function ObservationGrid(props: {
  value: PhotoObservations;
  onChange: (value: PhotoObservations) => void;
}) {
  const value = props.value;
  return (
    <div className="profile-details__body form-grid form-grid--three">
      <PeopleCountField value={value} onChange={props.onChange} />
      <ObservationTextField
        label="ما يحجب الوجه"
        field="obstruction"
        value={value}
        onChange={props.onChange}
      />
      <ObservationTextField
        label="الفئة العمرية الظاهرة، وصف فقط"
        field="apparentAgeBand"
        value={value}
        onChange={props.onChange}
      />
      <ObservationTextField
        label="وصف الشعر"
        field="hair"
        value={value}
        onChange={props.onChange}
      />
      <ObservationTextField
        label="وصف الملابس"
        field="clothing"
        value={value}
        onChange={props.onChange}
      />
      <label className="confirmation-check">
        <input
          type="checkbox"
          checked={value.filterSuspected ?? false}
          onChange={(event) =>
            props.onChange({ ...value, filterSuspected: event.target.checked })
          }
        />{" "}
        أشتبه في وجود مرشح ثقيل
      </label>
    </div>
  );
}

function PeopleCountField(props: {
  value: PhotoObservations;
  onChange: (value: PhotoObservations) => void;
}) {
  return (
    <label className="field">
      <span>عدد الأشخاص الظاهرين</span>
      <input
        type="number"
        required
        min={1}
        max={20}
        value={props.value.peopleCount ?? ""}
        onChange={(event) =>
          props.onChange({
            ...props.value,
            peopleCount:
              event.target.value === ""
                ? undefined
                : Number(event.target.value),
          })
        }
      />
    </label>
  );
}

function ObservationTextField(props: {
  label: string;
  field: "obstruction" | "apparentAgeBand" | "hair" | "clothing";
  value: PhotoObservations;
  onChange: (value: PhotoObservations) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        value={props.value[props.field] ?? ""}
        onChange={(event) =>
          props.onChange({ ...props.value, [props.field]: event.target.value })
        }
      />
    </label>
  );
}

function DuplicateChoice(props: {
  reservation: PhotoIntakeReservation;
  value: PhotoDuplicateChoice;
  onChange: (value: PhotoDuplicateChoice) => void;
}) {
  const groupName = useId();
  if (props.reservation.duplicateCandidates.length === 0) return null;
  return (
    <fieldset className="duplicate-choice">
      <legend>تشابه محتمل داخل هذه العائلة فقط</legend>
      <p>
        هذه ملاحظة محلية وليست مطابقة هوية. يمكن فتح سجل موجود أو إنشاء سجل
        منفصل بالاسم نفسه.
      </p>
      <label>
        <input
          type="radio"
          name={groupName}
          checked={props.value === "create_separate"}
          onChange={() => props.onChange("create_separate")}
        />{" "}
        إنشاء شخصية منفصلة
      </label>
      {props.reservation.duplicateCandidates.map((candidate) => (
        <label key={candidate.characterId}>
          <input
            type="radio"
            name={groupName}
            checked={props.value === candidate.characterId}
            onChange={() => props.onChange(candidate.characterId)}
          />{" "}
          فتح {candidate.name}، {relationshipLabel(candidate.relationship)}
        </label>
      ))}
    </fieldset>
  );
}

function IntakeRequirements(props: {
  peopleCountKnown: boolean;
  selectionReady: boolean;
  duplicateChosen: boolean;
  multipleReady: boolean;
}) {
  const missing = [
    !props.peopleCountKnown ? "سجّل عدد الأشخاص الظاهرين." : "",
    !props.selectionReady ? "حرّك إطار الشخص أو غيّر حجمه لتأكيد موضعه." : "",
    !props.duplicateChosen ? "اختر فتح السجل الموجود أو إنشاء سجل منفصل." : "",
    !props.multipleReady ? "أكّد أن الإطار يحيط بالشخص المقصود." : "",
  ].filter(Boolean);
  if (missing.length === 0) return null;
  return (
    <InlineNotice tone="warning">
      <ul className="compact-list">
        {missing.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </InlineNotice>
  );
}

function PhotoCommitActions(
  props: StagedPhotoProps & {
    canCommit: boolean;
    onCommit: () => Promise<void>;
  },
) {
  async function cancel() {
    props.setState("saving");
    props.setError("");
    try {
      await props.client.cancelPhoto(props.reservation.reservationToken);
      props.clearReservation();
      props.onCancel();
    } catch (reason) {
      props.setError(libraryError(reason));
      props.setState("error");
    }
  }
  return (
    <div className="library-form-actions">
      <button
        className="button button--primary"
        type="button"
        disabled={!props.canCommit || props.state === "saving"}
        onClick={() => void props.onCommit()}
      >
        حفظ المرجع والنسخة معًا
      </button>
      <button
        className="button button--quiet"
        type="button"
        onClick={() => void cancel()}
      >
        إلغاء الصورة
      </button>
      <FormMessage state={props.state} error={props.error} />
    </div>
  );
}
