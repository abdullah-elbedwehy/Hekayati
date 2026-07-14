import { useState } from "react";

import type { ApiClient } from "../../api";
import type {
  AuthoringProjectWorkspace,
  CreativeSheet,
  CreativeSheetIntent,
  LibrarySnapshot,
} from "../../types";

interface SheetLaneProps {
  client: ApiClient;
  familyId: string;
  workspace: AuthoringProjectWorkspace;
  library: LibrarySnapshot;
  sheets: CreativeSheet[];
  intents: CreativeSheetIntent[];
  busyId: string;
  onGenerate: (characterId: string) => void;
  onApprove: (
    sheet: CreativeSheet,
    intent: CreativeSheetIntent,
    notes: string,
  ) => void;
  onRequestChanges: (
    sheet: CreativeSheet,
    intent: CreativeSheetIntent,
    notes: string,
  ) => void;
}

interface SheetTicketProps extends Omit<
  SheetLaneProps,
  "workspace" | "busyId"
> {
  number: number;
  participant: AuthoringProjectWorkspace["version"]["storyConfig"]["participants"][number];
  busy: boolean;
}

export function SheetLane({
  client,
  familyId,
  workspace,
  library,
  sheets,
  intents,
  busyId,
  onGenerate,
  onApprove,
  onRequestChanges,
}: SheetLaneProps) {
  return (
    <section
      className="creative-section sheet-lane"
      aria-labelledby="sheets-title"
    >
      <div className="creative-section-heading">
        <div>
          <p className="eyebrow">بوابة الهوية</p>
          <h2 id="sheets-title">أوراق اعتماد الشخصيات</h2>
        </div>
        <p>خمسة مناظر ثابتة لكل شخصية قبل بدء الحكاية.</p>
      </div>
      <div className="sheet-strip">
        {workspace.version.storyConfig.participants.map(
          (participant, index) => (
            <SheetTicket
              key={participant.characterId}
              client={client}
              familyId={familyId}
              participant={participant}
              number={index + 1}
              library={library}
              sheets={sheets}
              intents={intents}
              busy={busyId === participant.characterId}
              onGenerate={onGenerate}
              onApprove={onApprove}
              onRequestChanges={onRequestChanges}
            />
          ),
        )}
      </div>
    </section>
  );
}

function SheetTicket({
  client,
  familyId,
  participant,
  number,
  library,
  sheets,
  intents,
  busy,
  onGenerate,
  onApprove,
  onRequestChanges,
}: SheetTicketProps) {
  const character = library.characters.find(
    (item) => item.id === participant.characterId,
  );
  const sheet = newestForCharacter(sheets, participant.characterId);
  const intent = newestForCharacter(intents, participant.characterId);
  const state = sheetState(sheet, intent);
  return (
    <article className="sheet-ticket">
      <div className="sheet-ticket__number" aria-hidden="true">
        {number}
      </div>
      <SheetTicketBody
        client={client}
        familyId={familyId}
        characterName={character?.currentVersion.profile.name ?? "شخصية"}
        role={participant.narrativeRole}
        state={state}
        sheet={sheet}
      />
      <SheetAction
        state={state}
        sheet={sheet}
        intent={intent}
        busy={busy}
        onGenerate={() => onGenerate(participant.characterId)}
        onApprove={(notes) =>
          sheet && intent ? onApprove(sheet, intent, notes) : undefined
        }
        onRequestChanges={(notes) =>
          sheet && intent ? onRequestChanges(sheet, intent, notes) : undefined
        }
      />
    </article>
  );
}

function SheetTicketBody({
  client,
  familyId,
  characterName,
  role,
  state,
  sheet,
}: {
  client: ApiClient;
  familyId: string;
  characterName: string;
  role: string;
  state: SheetState;
  sheet?: CreativeSheet;
}) {
  return (
    <div className="sheet-ticket__body">
      <div className="sheet-ticket__title">
        <h3>{characterName}</h3>
        <StatusLabel state={state} />
      </div>
      <p>{role}</p>
      {sheet ? (
        <a
          className="text-link"
          href={client.creativeSheetPdfUrl(familyId, sheet.id)}
          target="_blank"
          rel="noreferrer"
        >
          فتح ورقة PDF
        </a>
      ) : null}
    </div>
  );
}

type SheetState =
  "missing" | "generating" | "ready" | "approved" | "superseded" | "revision";

function SheetAction({
  state,
  sheet,
  intent,
  busy,
  onGenerate,
  onApprove,
  onRequestChanges,
}: {
  state: SheetState;
  sheet?: CreativeSheet;
  intent?: CreativeSheetIntent;
  busy: boolean;
  onGenerate: () => void;
  onApprove: (notes: string) => void;
  onRequestChanges: (notes: string) => void;
}) {
  if (state === "approved")
    return <span className="sheet-done">جاهزة للحكاية</span>;
  if (state === "generating")
    return (
      <span className="sheet-progress" role="status">
        جارٍ تجهيز المناظر…
      </span>
    );
  if (state === "ready" && sheet && intent?.approvalGateJobId)
    return (
      <ReadySheetAction
        busy={busy}
        onApprove={onApprove}
        onRequestChanges={onRequestChanges}
      />
    );
  return (
    <button
      className="button button--secondary"
      type="button"
      disabled={busy}
      onClick={onGenerate}
    >
      {busy
        ? "جارٍ البدء…"
        : state === "revision"
          ? "إنشاء محاولة جديدة"
          : "إنشاء الورقة"}
    </button>
  );
}

function ReadySheetAction({
  busy,
  onApprove,
  onRequestChanges,
}: {
  busy: boolean;
  onApprove: (notes: string) => void;
  onRequestChanges: (notes: string) => void;
}) {
  return (
    <div className="sheet-actions">
      <ApprovalAction busy={busy} onApprove={onApprove} />
      <ChangeRequestAction busy={busy} onRequestChanges={onRequestChanges} />
    </div>
  );
}

function ApprovalAction({
  busy,
  onApprove,
}: {
  busy: boolean;
  onApprove: (notes: string) => void;
}) {
  const [notes, setNotes] = useState("");
  return (
    <>
      <label className="field">
        <span>ملاحظات قرار الاعتماد</span>
        <input
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <button
        className="button button--accent"
        type="button"
        disabled={busy || !notes.trim()}
        onClick={() => onApprove(notes.trim())}
      >
        {busy ? "جارٍ تنفيذ القرار…" : "اعتماد الورقة"}
      </button>
    </>
  );
}

function ChangeRequestAction({
  busy,
  onRequestChanges,
}: {
  busy: boolean;
  onRequestChanges: (notes: string) => void;
}) {
  const [notes, setNotes] = useState("");
  return (
    <details className="sheet-change-request">
      <summary>طلب تعديل</summary>
      <label className="field">
        <span>ما المطلوب تغييره؟</span>
        <textarea
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <button
        className="button button--secondary"
        type="button"
        disabled={busy || !notes.trim()}
        onClick={() => {
          onRequestChanges(notes.trim());
          setNotes("");
        }}
      >
        إرسال الطلب وإنشاء محاولة لاحقة
      </button>
    </details>
  );
}

function StatusLabel({ state }: { state: SheetState }) {
  const labels: Record<SheetState, string> = {
    missing: "لم تبدأ",
    generating: "قيد التوليد",
    ready: "تنتظر الاعتماد",
    approved: "معتمدة",
    superseded: "قديمة",
    revision: "تحتاج تعديلًا",
  };
  return (
    <span className={`creative-status creative-status--${state}`}>
      {labels[state]}
    </span>
  );
}

function sheetState(
  sheet: CreativeSheet | undefined,
  intent: CreativeSheetIntent | undefined,
): SheetState {
  if (sheet?.status === "approved") return "approved";
  if (sheet?.status === "approved_superseded") return "superseded";
  if (intent && ["planned", "generating", "finalizing"].includes(intent.status))
    return "generating";
  if (sheet?.status === "revision_needed" || intent?.status === "rejected")
    return "revision";
  if (sheet?.status === "ready") return "ready";
  return "missing";
}

function newest<T extends { createdAt?: string; id: string }>(
  items: T[],
): T | undefined {
  return [...items].sort((left, right) =>
    (right.createdAt ?? right.id).localeCompare(left.createdAt ?? left.id),
  )[0];
}

function newestForCharacter<
  T extends { characterId: string; createdAt?: string; id: string },
>(items: T[], characterId: string): T | undefined {
  return newest(items.filter((item) => item.characterId === characterId));
}
