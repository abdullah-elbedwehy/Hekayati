import { readdir } from "node:fs/promises";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import sharp from "sharp";

export interface LibrarySnapshot {
  customers: Array<{
    id: string;
    name: string;
    consent: { granted: boolean; date: string; note: string } | null;
    status: "active" | "archived";
  }>;
  families: Array<{
    id: string;
    customerId: string;
    name: string;
    anchorCharacterId?: string;
    status: "active" | "archived";
  }>;
  characters: Array<{
    id: string;
    familyId: string;
    status: "active" | "archived";
    versionCount: number;
    currentVersion: {
      profile: {
        name: string;
        sourceMode: "photo" | "description" | "both";
        relationship: { type: string; customLabel?: string };
        referencePhotoIds: string[];
      };
    };
  }>;
  looks: Array<{
    id: string;
    characterId: string;
    status: "active" | "archived";
    versionCount: number;
    currentVersion: { name: string; clothing: string };
  }>;
  referencePhotos: Array<{
    id: string;
    characterId: string;
    thumbnailUrl: string;
    quality: {
      policyVersion: string;
      warnings: Array<{ code: string; source: string }>;
      observations: { peopleCount?: number; filterSuspected?: boolean };
    };
  }>;
}

export interface StagedPhoto {
  reservationToken: string;
  thumbnailUrl: string;
}

export function monitorExternalRequests(page: Page): string[] {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") external.push(request.url());
  });
  return external;
}

export async function createSyntheticPng(path: string): Promise<void> {
  const svg = Buffer.from(`
    <svg width="900" height="1200" xmlns="http://www.w3.org/2000/svg">
      <rect width="900" height="1200" fill="#fff8e8"/>
      <circle cx="450" cy="390" r="230" fill="#f5b08b"/>
      <circle cx="365" cy="345" r="28" fill="#17231d"/>
      <circle cx="535" cy="345" r="28" fill="#17231d"/>
      <path d="M330 470 Q450 560 570 470" fill="none" stroke="#17231d" stroke-width="24"/>
      <path d="M170 1060 Q450 650 730 1060" fill="#93c94a"/>
      <rect x="40" y="40" width="160" height="160" fill="#ffcf33"/>
      <rect x="700" y="1000" width="160" height="160" fill="#39a7a0"/>
    </svg>
  `);
  await sharp(svg).png().toFile(path);
}

export async function getLibrary(
  request: APIRequestContext,
  origin: string,
): Promise<LibrarySnapshot> {
  const response = await request.get(`${origin}/api/library`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<LibrarySnapshot>;
}

export async function getCsrfToken(
  request: APIRequestContext,
  origin: string,
): Promise<string> {
  const response = await request.get(`${origin}/api/bootstrap`);
  expect(response.status()).toBe(200);
  const value = (await response.json()) as { csrfToken: string };
  return value.csrfToken;
}

export async function expectCrossFamilyRefused(input: {
  request: APIRequestContext;
  origin: string;
  token: string;
  familyId: string;
  characterId: string;
  image: Buffer;
}) {
  const response = await input.request.post(
    `${input.origin}/api/library/photo-intake/stage`,
    {
      headers: secureHeaders(input.origin, input.token),
      multipart: {
        familyId: input.familyId,
        kind: "other",
        owner: JSON.stringify({
          type: "character",
          characterId: input.characterId,
        }),
        file: {
          name: "synthetic-family-boundary.png",
          mimeType: "image/png",
          buffer: input.image,
        },
      },
    },
  );
  expect(response.status()).toBe(403);
  await expect(response.json()).resolves.toEqual({
    code: "FAMILY_SCOPE_MISMATCH",
  });
}

export async function expectFullFrameMultiPersonRefused(input: {
  request: APIRequestContext;
  origin: string;
  token: string;
  reservationToken: string;
}) {
  const response = await input.request.post(
    `${input.origin}/api/library/photo-intake/commit`,
    {
      headers: {
        ...secureHeaders(input.origin, input.token),
        "content-type": "application/json",
      },
      data: {
        reservationToken: input.reservationToken,
        subjectSelection: { x: 0, y: 0, width: 1, height: 1 },
        subjectSelectionConfirmed: true,
        intendedPersonConfirmed: true,
        observations: { peopleCount: 2 },
        duplicateDecision: { action: "create_separate" },
      },
    },
  );
  expect(response.status()).toBe(422);
  await expect(response.json()).resolves.toMatchObject({
    code: "PHOTO_SUBJECT_SELECTION_REQUIRED",
  });
}

export async function expectAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}

export async function expectViewportFit(
  page: Page,
  size: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(size);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator("button, input, select, textarea")
      .evaluateAll((elements) =>
        elements
          .filter((element) => (element as HTMLElement).offsetParent !== null)
          .every((element) => {
            const box = element.getBoundingClientRect();
            return box.left >= -1 && box.right <= window.innerWidth + 1;
          }),
      ),
  ).toBe(true);
}

export async function expectKeyboardFocus(page: Page): Promise<void> {
  const target = page.getByRole("button", { name: "تحديث المكتبة" });
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement))
      break;
  }
  await expect(target).toBeFocused();
  const style = await target.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      outline: parseFloat(computed.outlineWidth),
      shadow: computed.boxShadow,
    };
  });
  expect(style.outline).toBeGreaterThanOrEqual(2);
  expect(style.shadow).not.toBe("none");
}

export async function managedFileCount(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    total += entry.isDirectory() ? await managedFileCount(path) : 1;
  }
  return total;
}

function secureHeaders(origin: string, token: string) {
  return { origin, "x-hekayati-csrf": token };
}
