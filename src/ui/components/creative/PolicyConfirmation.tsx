import type { CreativePolicyChallengeCode } from "../../types";

interface PolicyConfirmationProps {
  code: CreativePolicyChallengeCode;
  details: Readonly<Record<string, unknown>>;
  onConfirm: () => Promise<void>;
  onDismiss: () => void;
}

export function PolicyConfirmation({
  code,
  details,
  onConfirm,
  onDismiss,
}: PolicyConfirmationProps) {
  const presentation = code.startsWith("CREATIVE_POLICY_")
    ? promptPresentation(code, details)
    : capacityPresentation(code, details);
  return (
    <section
      className="creative-policy-confirmation"
      role="region"
      aria-labelledby="creative-policy-title"
      aria-describedby="creative-policy-summary creative-policy-guard"
    >
      <div className="creative-policy-confirmation__mark" aria-hidden="true">
        قرار
      </div>
      <DecisionCopy presentation={presentation} />
      <DecisionActions onConfirm={onConfirm} onDismiss={onDismiss} />
    </section>
  );
}

function DecisionCopy({ presentation }: { presentation: Presentation }) {
  return (
    <div className="creative-policy-confirmation__copy">
      <p className="eyebrow">توقّف آمن قبل الإرسال</p>
      <h2 id="creative-policy-title">{presentation.title}</h2>
      <p id="creative-policy-summary" role="status">
        {presentation.summary}
      </p>
      {presentation.facts.length > 0 ? (
        <dl className="creative-policy-confirmation__facts">
          {presentation.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p
        className="creative-policy-confirmation__alternative"
        id="creative-policy-guard"
      >
        <strong>ما الذي سيحدث؟</strong> {presentation.alternative}
      </p>
    </div>
  );
}

function DecisionActions({
  onConfirm,
  onDismiss,
}: Pick<PolicyConfirmationProps, "onConfirm" | "onDismiss">) {
  return (
    <div className="creative-policy-confirmation__actions">
      <button
        className="button button--primary"
        type="button"
        autoFocus
        onClick={() => void onConfirm()}
      >
        أوافق وأتابع
      </button>
      <button
        className="button button--secondary"
        type="button"
        onClick={onDismiss}
      >
        ليس الآن
      </button>
    </div>
  );
}

interface Presentation {
  title: string;
  summary: string;
  alternative: string;
  facts: Array<{ label: string; value: string }>;
}

function promptPresentation(
  code: CreativePolicyChallengeCode,
  details: Readonly<Record<string, unknown>>,
): Presentation {
  const categories = promptCategories(details.matchedCategories);
  const stale = code === "CREATIVE_POLICY_CONFIRMATION_STALE";
  return {
    title: "تحويل الوصف إلى أسلوب أصلي",
    summary: stale
      ? "تغيّر الوصف منذ القرار السابق. راجع التحويل المحدّث قبل المتابعة."
      : "وجد النظام اسمًا محميًا أو طلبًا لمحاكاة فنان حي، لذلك أوقف العملية قبل إرسال أي طلب.",
    alternative:
      "سيُستخدم وصف قصصي أصلي بخصائص بصرية عامة، بلا أسماء علامات محمية أو نسبة الأسلوب إلى فنان بعينه. لن يُرسل النص المخالف للمزوّد.",
    facts:
      categories.length > 0
        ? [{ label: "سبب التوقّف", value: categories.join("، ") }]
        : [],
  };
}

function capacityPresentation(
  code: CreativePolicyChallengeCode,
  details: Readonly<Record<string, unknown>>,
): Presentation {
  const counts = capacityCounts(details.counts);
  const maxReferences = safePositiveInteger(details.maxReferenceImages);
  const reliableCharacters = safePositiveInteger(
    details.reliableCharacterCount,
  );
  const participantExcess = details.participantExcess === true;
  const facts: Presentation["facts"] = [];
  if (counts && counts.selected < counts.requested)
    facts.push({
      label: "مراجع هذه المحاولة",
      value: `${counts.selected} من ${counts.requested}`,
    });
  if (maxReferences !== null)
    facts.push({
      label: "الحد الأقصى للمراجع",
      value: String(maxReferences),
    });
  if (reliableCharacters !== null)
    facts.push({
      label: "الشخصيات ضمن النطاق الموثوق",
      value: String(reliableCharacters),
    });
  if (participantExcess)
    facts.push({
      label: "تنبيه الاتساق",
      value: "عدد الشخصيات أكبر من النطاق الموثوق",
    });
  return {
    title: "اعتماد توزيع مراجع الصور",
    summary:
      code === "CREATIVE_CAPACITY_CONFIRMATION_STALE"
        ? "تغيّرت المراجع أو إعدادات النموذج منذ القرار السابق. راجع التوزيع المحدّث قبل المتابعة."
        : "يتجاوز عدد المراجع أو الشخصيات السعة الموثوقة للنموذج المحدد، لذلك توقفت العملية لقرارك.",
    alternative:
      "سيختار النظام توزيعًا متوازنًا داخل الحد المعلن، ويرسل المراجع المختارة فقط. لن يبدّل المزوّد أو النموذج بصمت.",
    facts,
  };
}

function promptCategories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels = new Set<string>();
  for (const category of value) {
    if (category === "franchise_trademark")
      labels.add("اسم علامة أو شخصية محمية");
    if (category === "living_artist") labels.add("محاكاة أسلوب فنان حي");
  }
  return [...labels];
}

function capacityCounts(
  value: unknown,
): { requested: number; selected: number } | null {
  if (!Array.isArray(value)) return null;
  let requested = 0;
  let selected = 0;
  for (const item of value) {
    if (!isRecord(item)) return null;
    const itemRequested = safeNonNegativeInteger(item.requested);
    const itemSelected = safeNonNegativeInteger(item.selected);
    if (
      itemRequested === null ||
      itemSelected === null ||
      itemSelected > itemRequested
    )
      return null;
    requested += itemRequested;
    selected += itemSelected;
  }
  return { requested, selected };
}

function safePositiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function safeNonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
