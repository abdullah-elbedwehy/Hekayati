import { createHash, randomBytes } from "node:crypto";

import { LibraryError } from "../../domain/library/errors.js";
import type { CharacterProfile } from "../../domain/library/index.js";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

interface CharacterCreatePreflight {
  familyId: string;
  profileHash: string;
  candidateIds: string[];
  expiresAtMs: number;
}

/** Runtime-only proof that the canonical duplicate result was shown first. */
export class CharacterCreatePreflightStore {
  private readonly entries = new Map<string, CharacterCreatePreflight>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now = () => Date.now(),
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      throw new Error("INVALID_CHARACTER_PREFLIGHT_TTL");
  }

  issue(
    familyId: string,
    profile: CharacterProfile,
    candidateIds: string[],
  ): { preflightToken: string; expiresAt: string } {
    this.sweep();
    const preflightToken = randomBytes(32).toString("base64url");
    const expiresAtMs = this.now() + this.ttlMs;
    this.entries.set(preflightToken, {
      familyId,
      profileHash: profileHash(profile),
      candidateIds: canonicalIds(candidateIds),
      expiresAtMs,
    });
    return {
      preflightToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consume(input: {
    preflightToken: string;
    familyId: string;
    profile: CharacterProfile;
    candidateIds: string[];
    createSeparateConfirmed: boolean;
  }): void {
    this.sweep();
    const entry = this.entries.get(input.preflightToken);
    this.entries.delete(input.preflightToken);
    const currentIds = canonicalIds(input.candidateIds);
    if (
      !entry ||
      entry.familyId !== input.familyId ||
      entry.profileHash !== profileHash(input.profile) ||
      !sameIds(entry.candidateIds, currentIds) ||
      (currentIds.length > 0 && !input.createSeparateConfirmed)
    )
      throw new LibraryError("DUPLICATE_DECISION_REQUIRED");
  }

  close(): void {
    this.entries.clear();
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(token);
    }
  }
}

function profileHash(profile: CharacterProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

function canonicalIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
