import { BridgeError } from "./errors.js";
export const budgets = {
  request: 128 * 1024,
  response: 64 * 1024,
  backendWait: 12000,
  call: 15000,
};
export function assertRequest(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > budgets.request)
    throw new BridgeError("REQUEST_TOO_LARGE", 413);
}
export function mcpResult(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}
export function resultSize(
  data: Record<string, unknown>,
  id: string | number = "x".repeat(128),
) {
  return Buffer.byteLength(
    JSON.stringify({ jsonrpc: "2.0", id, result: mcpResult(data) }),
  );
}
export function assertResponse(data: Record<string, unknown>) {
  if (resultSize(data) > budgets.response)
    throw new BridgeError("RESPONSE_TOO_LARGE", 413);
}
export async function readBoundedResponse(
  response: Response,
  max = budgets.response,
) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) {
    await response.body?.cancel();
    throw new BridgeError("RESPONSE_TOO_LARGE", 413);
  }
  if (!response.body) throw new BridgeError("INVALID_BACKEND_RESPONSE", 502);
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new BridgeError("RESPONSE_TOO_LARGE", 413);
      }
      parts.push(value);
    }
    const bytes = Buffer.concat(
      parts.map((b) => Buffer.from(b)),
      size,
    );
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new BridgeError("INVALID_BACKEND_RESPONSE", 502);
    }
  } finally {
    reader.releaseLock();
  }
}

import type { Principal } from "./contracts.js";
/** Defense in depth for explicit page/research calls; persisted session quotas remain backend-owned. */
export class ReadingBudgets {
  private states = new Map<
    string,
    { expires: number; bytes: number; reserved: number; active: number }
  >();
  async run<T>(p: Principal, fn: () => Promise<T>): Promise<T> {
    const now = Date.now(),
      key = JSON.stringify([p.id, p.clientId]);
    for (const [k, state] of this.states)
      if (state.expires <= now && state.active === 0) this.states.delete(k);
    let state = this.states.get(key);
    if (!state) {
      state = { expires: now + 60000, bytes: 0, reserved: 0, active: 0 };
      this.states.set(key, state);
    }
    if (state.active >= 2)
      throw new BridgeError("READ_CONCURRENCY_LIMIT", 429, true);
    if (state.bytes + state.reserved + 16384 > 2 * 1024 * 1024)
      throw new BridgeError("READ_RATE_LIMIT", 429, true);
    state.active++;
    state.reserved += 16384;
    try {
      const result = await fn();
      const value = result as any;
      const text =
        typeof value?.text === "string"
          ? value.text
          : typeof value?.data?.content === "string"
            ? value.data.content
            : "";
      state.bytes += Buffer.byteLength(text);
      return result;
    } finally {
      state.active--;
      state.reserved -= 16384;
    }
  }
}

export function assertWriteBudgets(value: unknown) {
  if (!value || typeof value !== "object") return;
  const input = value as any;
  if (
    typeof input.content === "string" &&
    Buffer.byteLength(input.content) > 32768
  )
    throw new BridgeError("REQUEST_TOO_LARGE", 413);
  if (Array.isArray(input.edits)) {
    const bytes = input.edits.reduce(
      (total: number, e: any) =>
        total +
        (e?.type === "replace_text" ? [e.before, e.after] : [e?.insert]).reduce(
          (n: number, s: unknown) =>
            n + (typeof s === "string" ? Buffer.byteLength(s) : 0),
          0,
        ),
      0,
    );
    if (input.edits.length > 20 || bytes > 32768)
      throw new BridgeError("REQUEST_TOO_LARGE", 413);
  }
}
