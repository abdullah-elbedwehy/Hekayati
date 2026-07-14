import type {
  CharacterProfile,
  RelationshipType,
  SourceMode,
} from "../../types";
import {
  joinList,
  relationshipOptions,
  sourceModeOptions,
  splitList,
} from "./library-utils";

interface ProfileFieldsProps {
  profile: CharacterProfile;
  setProfile: (profile: CharacterProfile) => void;
  relationshipLocked?: boolean;
}

export function CharacterProfileFields(props: ProfileFieldsProps) {
  return (
    <div className="profile-fields">
      <IdentityFields {...props} />
      <AppearanceFields {...props} />
      <details className="profile-details">
        <summary>سمات إضافية للشخصية</summary>
        <AdditionalFields {...props} />
      </details>
    </div>
  );
}

function IdentityFields({
  profile,
  setProfile,
  relationshipLocked,
}: ProfileFieldsProps) {
  return (
    <fieldset className="form-fieldset">
      <legend>الهوية داخل العائلة</legend>
      <div className="form-grid">
        <TextField
          label="الاسم"
          required
          value={profile.name}
          onChange={(name) => setProfile({ ...profile, name })}
        />
        <TextField
          label="الاسم المختصر"
          value={profile.nickname}
          onChange={(nickname) => setProfile({ ...profile, nickname })}
        />
        <RelationshipField
          profile={profile}
          setProfile={setProfile}
          locked={relationshipLocked}
        />
        <CustomRelationshipField profile={profile} setProfile={setProfile} />
        <SourceModeField profile={profile} setProfile={setProfile} />
        <DemographicFields profile={profile} setProfile={setProfile} />
      </div>
    </fieldset>
  );
}

function AppearanceFields({ profile, setProfile }: ProfileFieldsProps) {
  const needsDescription = profile.sourceMode !== "photo";
  return (
    <fieldset className="form-fieldset">
      <legend>المظهر الثابت</legend>
      <label className="field field--wide">
        <span>وصف المظهر</span>
        <textarea
          required={needsDescription}
          value={profile.appearanceDescription}
          onChange={(event) =>
            setProfile({
              ...profile,
              appearanceDescription: event.target.value,
            })
          }
          placeholder="وصف واقعي وواضح من دون وعد بتطابق رياضي"
        />
      </label>
      <PhysicalFields profile={profile} setProfile={setProfile} />
      <AppearanceLists profile={profile} setProfile={setProfile} />
    </fieldset>
  );
}

function CustomRelationshipField({ profile, setProfile }: ProfileFieldsProps) {
  if (profile.relationship.type !== "custom") return null;
  return (
    <TextField
      label="وصف العلاقة"
      required
      value={profile.relationship.customLabel ?? ""}
      onChange={(customLabel) =>
        setProfile({
          ...profile,
          relationship: { type: "custom", customLabel },
        })
      }
    />
  );
}

function DemographicFields({ profile, setProfile }: ProfileFieldsProps) {
  return (
    <>
      <TextField
        label="العمر أو النطاق العمري"
        value={profile.ageOrRange}
        onChange={(ageOrRange) => setProfile({ ...profile, ageOrRange })}
      />
      <TextField
        label="النوع كما وصفه العميل"
        value={profile.gender}
        onChange={(gender) => setProfile({ ...profile, gender })}
      />
    </>
  );
}

function PhysicalFields({ profile, setProfile }: ProfileFieldsProps) {
  const fields: Array<[string, keyof CharacterProfile]> = [
    ["لون البشرة", "skinTone"],
    ["الشعر", "hair"],
    ["لون العينين", "eyeColor"],
    ["الطول النسبي", "relativeHeight"],
    ["البنية", "build"],
    ["النظارة", "glasses"],
    ["غطاء الرأس أو الحجاب", "hijab"],
  ];
  return (
    <div className="form-grid form-grid--three">
      {fields.map(([label, key]) => (
        <TextField
          key={key}
          label={label}
          value={profile[key] as string}
          onChange={(value) => setProfile({ ...profile, [key]: value })}
        />
      ))}
    </div>
  );
}

function AppearanceLists({ profile, setProfile }: ProfileFieldsProps) {
  return (
    <>
      <ListField
        label="علامات مميزة"
        value={profile.distinguishingFeatures}
        onChange={(distinguishingFeatures) =>
          setProfile({ ...profile, distinguishingFeatures })
        }
      />
      <ListField
        label="إكسسوارات ثابتة"
        value={profile.accessories}
        onChange={(accessories) => setProfile({ ...profile, accessories })}
      />
    </>
  );
}

function AdditionalFields({ profile, setProfile }: ProfileFieldsProps) {
  return (
    <div className="profile-details__body">
      <div className="form-grid">
        <ListField
          label="الاهتمامات"
          value={profile.interests}
          onChange={(interests) => setProfile({ ...profile, interests })}
        />
        <ListField
          label="الأشياء المفضلة"
          value={profile.favoriteObjects}
          onChange={(favoriteObjects) =>
            setProfile({ ...profile, favoriteObjects })
          }
        />
        <TextField
          label="اللون المفضل"
          value={profile.favoriteColor}
          onChange={(favoriteColor) =>
            setProfile({ ...profile, favoriteColor })
          }
        />
        <ListField
          label="سمات الشخصية"
          value={profile.personalityTraits}
          onChange={(personalityTraits) =>
            setProfile({ ...profile, personalityTraits })
          }
        />
        <TextField
          label="أسلوب الكلام"
          value={profile.speakingStyle}
          onChange={(speakingStyle) =>
            setProfile({ ...profile, speakingStyle })
          }
        />
      </div>
      <label className="field">
        <span>ملاحظات</span>
        <textarea
          value={profile.notes}
          onChange={(event) =>
            setProfile({ ...profile, notes: event.target.value })
          }
        />
      </label>
    </div>
  );
}

function RelationshipField(props: ProfileFieldsProps & { locked?: boolean }) {
  return (
    <label className="field">
      <span>العلاقة بالطفل محور العائلة</span>
      <select
        disabled={props.locked}
        value={props.profile.relationship.type}
        onChange={(event) =>
          setRelationship(props, event.target.value as RelationshipType)
        }
      >
        {relationshipOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {props.locked ? (
        <small>علاقة الطفل محور العائلة ثابتة في الإصدار الأول.</small>
      ) : null}
    </label>
  );
}

function SourceModeField({ profile, setProfile }: ProfileFieldsProps) {
  return (
    <label className="field">
      <span>مصدر المرجع</span>
      <select
        value={profile.sourceMode}
        onChange={(event) =>
          setProfile({
            ...profile,
            sourceMode: event.target.value as SourceMode,
          })
        }
      >
        {sourceModeOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextField(props: {
  label: string;
  value: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        required={props.required}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function ListField(props: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        value={joinList(props.value)}
        onChange={(event) => props.onChange(splitList(event.target.value))}
        placeholder="افصل بين العناصر بفاصلة"
      />
    </label>
  );
}

function setRelationship(props: ProfileFieldsProps, type: RelationshipType) {
  props.setProfile({
    ...props.profile,
    relationship: type === "custom" ? { type, customLabel: "" } : { type },
  });
}
