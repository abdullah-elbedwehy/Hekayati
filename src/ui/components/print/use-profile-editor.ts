import { useState } from "react";

import type {
  PrinterProfileProjection,
  PrintProfileDraft,
} from "../../print-types";
import type { PrintState } from "../../views/use-print-state";
import { defaultDraft, draftFromProfile } from "./print-profile-model";

export interface PrintProfileEditor {
  editing: PrinterProfileProjection | null;
  editingId: string;
  name: string;
  draft: PrintProfileDraft;
  iccState: string;
  templateState: string;
  setName: (value: string) => void;
  setDraft: (value: PrintProfileDraft) => void;
  setIccState: (value: string) => void;
  setTemplateState: (value: string) => void;
  select: (id: string) => void;
  reset: () => void;
}

export function useProfileEditor(state: PrintState): PrintProfileEditor {
  const [editingId, setEditingId] = useState("");
  const [name, setName] = useState("طابعة A4");
  const [draft, setDraft] = useState<PrintProfileDraft>(defaultDraft());
  const [iccState, setIccState] = useState("لم يُستورد ملف ألوان");
  const [templateState, setTemplateState] = useState("لا يوجد قالب غلاف");
  const editing =
    state.profiles.find((item) => item.profile.id === editingId) ?? null;
  const reset = () => {
    setEditingId("");
    setName("طابعة A4");
    setDraft(defaultDraft());
    setIccState("لم يُستورد ملف ألوان");
    setTemplateState("لا يوجد قالب غلاف");
  };
  const select = (id: string) => {
    const selected =
      state.profiles.find((item) => item.profile.id === id) ?? null;
    if (!selected) return reset();
    setEditingId(id);
    setName(selected.profile.name);
    setDraft(draftFromProfile(selected));
    setIccState(iccStatus(selected));
    setTemplateState(templateStatus(selected));
  };
  return {
    editing,
    editingId,
    name,
    draft,
    iccState,
    templateState,
    setName,
    setDraft,
    setIccState,
    setTemplateState,
    select,
    reset,
  };
}

function iccStatus(profile: PrinterProfileProjection): string {
  return profile.version.color.mode === "cmyk"
    ? "ملف CMYK مرتبط ومحفوظ محليًا"
    : "مسار RGB مباشر";
}

function templateStatus(profile: PrinterProfileProjection): string {
  return profile.version.coverTemplate
    ? "قالب الغلاف مرتبط ومحفوظ محليًا"
    : "لا يوجد قالب غلاف";
}
