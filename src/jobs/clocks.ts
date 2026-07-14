import { randomUUID } from "node:crypto";

import type { JobClock } from "./types.js";

export class SystemJobClock implements JobClock {
  monotonicNow(): number {
    return performance.now();
  }

  wallNowIso(): string {
    return new Date().toISOString();
  }
}

export function createBootId(): string {
  return randomUUID();
}
