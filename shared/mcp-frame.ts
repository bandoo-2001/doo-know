/** Complete successful tool result, including text duplication and the largest accepted RPC ID. */
export function mcpResultFrameSize(data: unknown): number {
  const frame = { jsonrpc: '2.0', id: '\0'.repeat(128), result: { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] } };
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}
export const mcpMaximumFrameBytes = 64 * 1024;
