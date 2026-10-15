export const limits = {
  file: 20 * 1024 * 1024,
  ordinary: 1024 * 1024,
  longLine: 32768,
  io: 65536,
  ttl: 15 * 60 * 1000,
  request: 128 * 1024,
  response: 64 * 1024,
};
export const readPolicies = {
  mcp: {
    defaultBytes: 8192,
    maxBytes: 16384,
    pages: 32,
    bytes: 256 * 1024,
    rate: 2 * 1024 * 1024,
    response: 65536,
  },
  web: {
    defaultBytes: 128 * 1024,
    maxBytes: 128 * 1024,
    pages: 200,
    bytes: 20 * 1024 * 1024,
    rate: 32 * 1024 * 1024,
    response: 512 * 1024,
  },
  public: {
    defaultBytes: 16384,
    maxBytes: 16384,
    pages: 200,
    bytes: 20 * 1024 * 1024,
    rate: 2 * 1024 * 1024,
    response: 65536,
  },
};
export type ReadChannel = keyof typeof readPolicies;
export function utf8Prefix(bytes: Buffer, max: number) {
  let n = Math.min(max, bytes.length);
  while (n > 0 && n < bytes.length && (bytes[n] & 0xc0) === 0x80) n--;
  return bytes.subarray(0, n);
}
export function boundedText(value: string, max: number) {
  return utf8Prefix(Buffer.from(value), max).toString('utf8');
}
export function messageSize(data: unknown) {
  const wrapped = { data };
  return Buffer.byteLength(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'x'.repeat(128),
      result: {
        structuredContent: wrapped,
        content: [{ type: 'text', text: JSON.stringify(wrapped) }],
      },
    }),
  );
}
