import type { CallControl } from "../contract.js";
import { makeFailure, type NormalizedFailure } from "../failures.js";
import { classifyGeminiError } from "./classify.js";

export type ControlledResult<T> =
  { ok: true; value: T } | { ok: false; failure: NormalizedFailure };

export function controlledGeminiCall<T>(
  control: CallControl,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<ControlledResult<T>> {
  if (control.signal.aborted) {
    return Promise.resolve({
      ok: false,
      failure: makeFailure("user_canceled"),
    });
  }
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result: ControlledResult<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      control.signal.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = (): void => {
      controller.abort();
      finish({ ok: false, failure: makeFailure("user_canceled") });
    };
    control.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(
      () => {
        controller.abort();
        finish({ ok: false, failure: makeFailure("timeout") });
      },
      Math.max(1, control.timeoutMs),
    );
    void Promise.resolve()
      .then(() => call(controller.signal))
      .then((value) => finish({ ok: true, value }))
      .catch((error: unknown) => {
        finish({
          ok: false,
          failure: makeFailure(classifyGeminiError(error)),
        });
      });
  });
}
