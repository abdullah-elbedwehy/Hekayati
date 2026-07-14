import { expect, type Page } from "@playwright/test";

export async function openLibrary(page: Page, origin: string): Promise<void> {
  await page.goto(origin);
  const libraryNavigation = page.getByRole("button", {
    name: "مكتبة العائلات",
    exact: true,
  });
  await libraryNavigation.waitFor();
  const acknowledge = page.getByRole("button", { name: "فهمت" });
  if (await acknowledge.isVisible()) {
    await acknowledge.click();
    await expect(acknowledge).toBeHidden();
  }
  await libraryNavigation.click();
  await expect(
    page.getByRole("heading", { name: "مكتبة العائلات والشخصيات" }),
  ).toBeVisible();
}

export async function createCustomer(page: Page, name: string): Promise<void> {
  await page.getByLabel("اسم العميل").fill(name);
  await page.getByLabel("رقم واتساب").fill("+201000000000");
  await page.getByLabel("ملاحظات محلية").fill("بيانات اصطناعية للاختبار فقط");
  await page.getByRole("button", { name: "حفظ العميل" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

export async function recordConsent(
  page: Page,
  decision: "موافقة ممنوحة" | "موافقة غير ممنوحة",
  note: string,
): Promise<void> {
  await page.getByLabel(decision, { exact: true }).check();
  await page.getByLabel("ملاحظة القرار").fill(note);
  await page.getByRole("button", { name: "حفظ قرار الموافقة" }).click();
  await expect(page.getByText("حُفظ التغيير على هذا الجهاز.")).toBeVisible();
}

export async function createFamily(page: Page, name: string): Promise<void> {
  const field = page.getByLabel("اسم العائلة");
  if (!(await field.isVisible()))
    await page.getByRole("button", { name: "إضافة عائلة" }).click();
  await field.fill(name);
  await page.getByRole("button", { name: "حفظ العائلة" }).click();
  await expect(familyButton(page, name)).toBeVisible();
}

export async function renameFamily(
  page: Page,
  from: string,
  to: string,
): Promise<void> {
  await page.getByRole("button", { name: "تعديل اسم العائلة" }).click();
  const field = page.getByLabel("اسم العائلة");
  await expect(field).toHaveValue(from);
  await field.fill(to);
  await page.getByRole("button", { name: "حفظ الاسم" }).click();
  await expect(familyButton(page, to)).toBeVisible();
}

export async function selectFamily(page: Page, name: string): Promise<void> {
  await familyButton(page, name).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

export async function createDescriptionCharacter(
  page: Page,
  input: {
    name: string;
    relationship?: string;
    duplicate?: "open" | "separate";
  },
): Promise<void> {
  await openCharacterForm(page);
  await page.getByLabel("الاسم", { exact: true }).fill(input.name);
  if (input.relationship)
    await page
      .getByLabel("العلاقة بالطفل محور العائلة")
      .selectOption({ label: input.relationship });
  await page
    .getByLabel("وصف المظهر")
    .fill(`وصف اصطناعي آمن للشخصية ${input.name}`);
  await page.getByRole("button", { name: "حفظ الشخصية" }).click();
  if (input.duplicate) {
    const choice =
      input.duplicate === "open"
        ? page.getByRole("radio", { name: new RegExp(`فتح ${input.name}`) })
        : page.getByRole("radio", { name: "إنشاء سجل منفصل" });
    await expect(choice).toBeVisible();
    await choice.check();
    await page.getByRole("button", { name: "حفظ الشخصية" }).click();
  }
  await expect(page.getByLabel("الاسم", { exact: true })).toBeHidden();
}

export async function beginPhotoCharacter(
  page: Page,
  name: string,
): Promise<void> {
  await openCharacterForm(page);
  await page.getByLabel("الاسم", { exact: true }).fill(name);
  await page
    .getByLabel("العلاقة بالطفل محور العائلة")
    .selectOption({ label: "الأخت" });
  await page.getByLabel("مصدر المرجع").selectOption({ label: "صورة فقط" });
  await page.getByRole("button", { name: "متابعة إلى الصورة" }).click();
  await expect(page.getByText("مراجع موصى بها")).toBeVisible();
}

export async function selectCharacter(page: Page, name: string): Promise<void> {
  const row = page.locator(".character-rail button").filter({ hasText: name });
  await row.first().click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

export async function createLook(
  page: Page,
  name: string,
  clothing: string,
): Promise<void> {
  await page.getByRole("button", { name: "إضافة مظهر" }).click();
  await page.getByLabel("اسم المظهر").fill(name);
  await page.getByLabel("وصف الملابس").fill(clothing);
  await page.getByRole("button", { name: "حفظ كنسخة جديدة" }).click();
  await expect(lookRow(page, name)).toBeVisible();
}

export function familyButton(page: Page, name: string) {
  return page.locator(".family-tab").filter({ hasText: name });
}

export function lookRow(page: Page, name: string) {
  return page.locator(".look-row").filter({ hasText: name });
}

async function openCharacterForm(page: Page): Promise<void> {
  const name = page.getByLabel("الاسم", { exact: true });
  if (!(await name.isVisible()))
    await page.getByRole("button", { name: "إضافة شخصية" }).click();
  await expect(name).toBeVisible();
}
