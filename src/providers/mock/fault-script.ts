import type { CallControl } from "../contract.js";
import {
  failureCategorySchema,
  makeFailure,
  type FailureCategory,
  type NormalizedFailure,
} from "../failures.js";

export type MockOperation =
  "capabilities" | "connection" | "text" | "structured" | "image";

export interface MockFault {
  operation: MockOperation;
  category?: FailureCategory;
  latencyMs?: number;
  rawStructured?: string;
}

export class MockFaultScript {
  private readonly queue: MockFault[];
  consumed = 0;

  constructor(faults: readonly MockFault[] = []) {
    this.queue = faults.map(validateFault);
  }

  take(operation: MockOperation): MockFault | undefined {
    const index = this.queue.findIndex(
      (fault) => fault.operation === operation,
    );
    if (index === -1) return undefined;
    this.consumed += 1;
    return this.queue.splice(index, 1)[0];
  }
}

export async function runFaultDelay(
  fault: MockFault | undefined,
  control: CallControl,
): Promise<NormalizedFailure | null> {
  if (control.signal.aborted) return makeFailure("user_canceled");
  const latencyMs = fault?.latencyMs ?? 0;
  if (latencyMs > 0) {
    const interrupted = await interruptibleDelay(latencyMs, control);
    if (interrupted) return makeFailure(interrupted);
  }
  return fault?.category ? makeFailure(fault.category) : null;
}

function interruptibleDelay(
  latencyMs: number,
  control: CallControl,
): Promise<"timeout" | "user_canceled" | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: "timeout" | "user_canceled" | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(latency);
      clearTimeout(timeout);
      control.signal.removeEventListener("abort", cancel);
      resolve(value);
    };
    const cancel = (): void => finish("user_canceled");
    const latency = setTimeout(() => finish(null), latencyMs);
    const timeout = setTimeout(
      () => finish("timeout"),
      Math.max(1, control.timeoutMs),
    );
    control.signal.addEventListener("abort", cancel, { once: true });
  });
}

function validateFault(fault: MockFault): MockFault {
  if (fault.category) failureCategorySchema.parse(fault.category);
  if (
    fault.latencyMs !== undefined &&
    (!Number.isSafeInteger(fault.latencyMs) || fault.latencyMs < 0)
  ) {
    throw new Error("INVALID_MOCK_LATENCY");
  }
  return { ...fault };
}
