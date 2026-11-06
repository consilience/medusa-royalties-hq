// Extra checks on what the tests send and receive. None are set by default.
// A checkout can set its own from jest.local.setup.ts, which jest.config.js
// loads when the file exists.

export type Operation = "connection" | "put" | "validate" | "get";

export interface WireChecks {
  payload(value: unknown): string[];
  answer(operation: Operation, status: number, body: unknown): string[];
}

let checks: WireChecks | null = null;

export function setWireChecks(next: WireChecks | null): void {
  checks = next;
}

export function payloadErrors(value: unknown): string[] {
  return checks?.payload(value) ?? [];
}

export function answerErrors(operation: Operation, status: number, body: unknown): string[] {
  return checks?.answer(operation, status, body) ?? [];
}
