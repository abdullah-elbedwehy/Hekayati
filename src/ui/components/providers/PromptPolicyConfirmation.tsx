import { useState } from "react";

import type { PromptPolicyCheck } from "../../types";

type RequiredCheck = Extract<
  PromptPolicyCheck,
  { status: "confirmation_required" }
>;

export function PromptPolicyConfirmation(props: {
  check: RequiredCheck;
  busy: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [accepted, setAccepted] = useState(false);
  return (
    <div
      className="policy-confirmation"
      role="group"
      aria-labelledby="policy-title"
    >
      <div>
        <p className="eyebrow">يتطلب تأكيدًا صريحًا</p>
        <h4 id="policy-title">استخدم وصفًا بصريًا أصليًا</h4>
        <p>{categoryText(props.check.matchedCategories)}</p>
      </div>
      <blockquote>{props.check.alternativePrompt}</blockquote>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>
          أوافق على استخدام البديل الأصلي أعلاه بدلًا من المرجع المحمي.
        </span>
      </label>
      <button
        className="button button--accent"
        type="button"
        disabled={!accepted || props.busy}
        onClick={() => void props.onConfirm()}
      >
        تأكيد البديل الأصلي
      </button>
    </div>
  );
}

function categoryText(categories: RequiredCheck["matchedCategories"]): string {
  const labels = categories.map((category) =>
    category === "living_artist" ? "اسم فنان حي" : "علامة أو عالم قصصي محمي",
  );
  return `وُجد في الوصف: ${labels.join("، ")}. لن يُرسل شيء قبل التأكيد.`;
}
