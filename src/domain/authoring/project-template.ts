import type { ParsedProjectInput, StoryConfig } from "./schemas.js";
import type { TemplateRecord, TemplateService } from "./template-service.js";

export function resolveProjectTemplate(
  templates: TemplateService,
  input: ParsedProjectInput,
  previous: StoryConfig | null,
): TemplateRecord | null {
  if (input.storyType !== "saved_template") return null;
  if (
    previous?.storyType === "saved_template" &&
    previous.templateId &&
    input.templateId === previous.templateId &&
    !input.templateSeedKey
  )
    return templates.getVersion(
      previous.templateId,
      previous.templateVersionId!,
    );
  return templates.resolveSelectable({
    templateId: input.templateId,
    seedKey: input.templateSeedKey,
  });
}
