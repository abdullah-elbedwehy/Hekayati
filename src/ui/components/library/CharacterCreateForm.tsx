import { useState, type FormEvent } from "react";

import type {
  ApiClient,
  CharacterInput,
  CharacterPreflightResult,
} from "../../api";
import type { CharacterProfile, LibraryFamily } from "../../types";
import { CharacterProfileFields } from "./CharacterProfileFields";
import { EditorActions, InlineNotice } from "./LibraryPrimitives";
import { PhotoIntake } from "./PhotoIntake";
import {
  emptyCharacterProfile,
  libraryError,
  relationshipLabel,
} from "./library-utils";

type CharacterCandidate =
  CharacterPreflightResult["duplicateCandidates"][number];

interface CharacterCreateFormProps {
  client: ApiClient;
  family: LibraryFamily;
  onCreate: (input: CharacterInput) => Promise<void>;
  onOpenExisting: (id: string) => void;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}

export function CharacterCreateForm(props: CharacterCreateFormProps) {
  const draft = useCharacterCreateDraft(props);
  if (draft.photoStep)
    return (
      <PhotoCharacterStep
        profile={draft.profile}
        props={props}
        onCancel={() => draft.setPhotoStep(false)}
      />
    );
  return (
    <CharacterDraftForm
      anchorRequired={draft.anchorRequired}
      profile={draft.profile}
      setProfile={draft.updateProfile}
      candidates={draft.candidates}
      duplicateDecision={draft.duplicateDecision}
      setDuplicateDecision={draft.setDuplicateDecision}
      state={draft.state}
      error={draft.error}
      onSubmit={draft.submit}
      onClose={props.onClose}
    />
  );
}

function useCharacterCreateDraft(props: CharacterCreateFormProps) {
  const anchorRequired = !props.family.anchorCharacterId;
  const [profile, setProfile] = useState(() =>
    emptyCharacterProfile(anchorRequired ? "main_child" : "father"),
  );
  const [photoStep, setPhotoStep] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  const [preflight, setPreflight] = useState<CharacterPreflightResult | null>(
    null,
  );
  const [duplicateDecision, setDuplicateDecision] = useState("");
  function updateProfile(next: CharacterProfile) {
    setProfile(next);
    setPreflight(null);
    setDuplicateDecision("");
    setState("idle");
    setError("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (profile.sourceMode !== "description") {
      setPhotoStep(true);
      return;
    }
    await submitDescriptionDraft({
      props,
      profile,
      preflight,
      duplicateDecision,
      setPreflight,
      setState,
      setError,
    });
  }
  return {
    anchorRequired,
    profile,
    updateProfile,
    photoStep,
    setPhotoStep,
    state,
    error,
    candidates: preflight?.duplicateCandidates ?? [],
    duplicateDecision,
    setDuplicateDecision,
    submit,
  };
}

function CharacterDraftForm(props: {
  anchorRequired: boolean;
  profile: CharacterProfile;
  setProfile: (profile: CharacterProfile) => void;
  candidates: CharacterCandidate[];
  duplicateDecision: string;
  setDuplicateDecision: (value: string) => void;
  state: "idle" | "saving" | "error";
  error: string;
  onSubmit: (event: FormEvent) => Promise<void>;
  onClose: () => void;
}) {
  const label =
    props.profile.sourceMode === "description"
      ? "حفظ الشخصية"
      : "متابعة إلى الصورة";
  return (
    <form
      className="character-editor"
      onSubmit={(event) => void props.onSubmit(event)}
    >
      <AnchorNotice required={props.anchorRequired} />
      <CharacterProfileFields
        profile={props.profile}
        setProfile={props.setProfile}
        relationshipLocked={props.anchorRequired}
      />
      <DuplicateAdvisory
        candidates={props.candidates}
        value={props.duplicateDecision}
        onChange={props.setDuplicateDecision}
      />
      <EditorActions
        state={props.state}
        error={props.error}
        primaryLabel={label}
        onCancel={props.onClose}
      />
    </form>
  );
}

function PhotoCharacterStep(props: {
  profile: CharacterProfile;
  props: CharacterCreateFormProps;
  onCancel: () => void;
}) {
  const parent = props.props;
  return (
    <PhotoIntake
      client={parent.client}
      familyId={parent.family.id}
      owner={{ type: "new_character", draft: props.profile }}
      subjectName={props.profile.name}
      onComplete={async (result) => {
        await parent.onRefresh();
        parent.onOpenExisting(result.characterId);
        parent.onClose();
      }}
      onCancel={props.onCancel}
    />
  );
}

function AnchorNotice({ required }: { required: boolean }) {
  return required ? (
    <InlineNotice tone="warning">
      هذه أول شخصية نشطة في العائلة، لذلك يجب أن تكون الطفل محور العائلة. لا
      يمكن نقل هذا الدور إلى شخصية أخرى لاحقًا.
    </InlineNotice>
  ) : (
    <InlineNotice tone="info">
      العلاقة هنا عائلية وثابتة على النسخة. دور الشخصية داخل قصة يُختار لاحقًا
      داخل المشروع ولا يغيّر هذا السجل.
    </InlineNotice>
  );
}

function DuplicateAdvisory(props: {
  candidates: CharacterCandidate[];
  value: string;
  onChange: (value: string) => void;
}) {
  if (props.candidates.length === 0) return null;
  return (
    <fieldset className="duplicate-choice">
      <legend>نتيجة فحص التشابه المحلي</legend>
      <p>
        هذه النتيجة صادرة من السجل المحلي للعائلة الحالية فقط. ليست مطابقة هوية،
        والأسماء المكررة مسموحة، لكن يجب اختيار الإجراء صراحة.
      </p>
      {props.candidates.map((candidate) => (
        <label key={candidate.characterId}>
          <input
            type="radio"
            name="duplicate-character-decision"
            required
            checked={props.value === candidate.characterId}
            onChange={() => props.onChange(candidate.characterId)}
          />{" "}
          فتح {candidate.name}، {relationshipLabel(candidate.relationship)}
        </label>
      ))}
      <label>
        <input
          type="radio"
          name="duplicate-character-decision"
          required
          checked={props.value === "create_separate"}
          onChange={() => props.onChange("create_separate")}
        />{" "}
        إنشاء سجل منفصل
      </label>
    </fieldset>
  );
}

async function submitDescriptionDraft(input: {
  props: CharacterCreateFormProps;
  profile: CharacterProfile;
  preflight: CharacterPreflightResult | null;
  duplicateDecision: string;
  setPreflight: (value: CharacterPreflightResult | null) => void;
  setState: (value: "idle" | "saving" | "error") => void;
  setError: (value: string) => void;
}) {
  input.setState("saving");
  input.setError("");
  try {
    const preflight = await resolveCharacterPreflight(input);
    if (!input.preflight && preflight.duplicateCandidates.length > 0) {
      input.setPreflight(preflight);
      input.setState("idle");
      return;
    }
    const existing = preflight.duplicateCandidates.find(
      (candidate) => candidate.characterId === input.duplicateDecision,
    );
    if (existing) {
      input.props.onOpenExisting(existing.characterId);
      input.props.onClose();
      return;
    }
    if (
      preflight.duplicateCandidates.length > 0 &&
      input.duplicateDecision !== "create_separate"
    ) {
      input.setState("idle");
      return;
    }
    await input.props.onCreate({
      profile: input.profile,
      preflightToken: preflight.preflightToken,
      duplicateDecision:
        preflight.duplicateCandidates.length > 0
          ? { action: "create_separate" }
          : undefined,
    });
    input.props.onClose();
  } catch (reason) {
    input.setPreflight(null);
    input.setError(libraryError(reason));
    input.setState("error");
  }
}

function resolveCharacterPreflight(input: {
  props: CharacterCreateFormProps;
  profile: CharacterProfile;
  preflight: CharacterPreflightResult | null;
}) {
  return (
    input.preflight ??
    input.props.client.preflightCharacter(input.props.family.id, input.profile)
  );
}
