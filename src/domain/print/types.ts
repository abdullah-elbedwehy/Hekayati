import type { z } from "zod";

import type {
  printerBlankRuleSchema,
  printerProfileDraftSchema,
} from "./schemas.js";

export type PrinterBlankRule = z.infer<typeof printerBlankRuleSchema>;
export type PrinterProfileDraft = z.infer<typeof printerProfileDraftSchema>;
